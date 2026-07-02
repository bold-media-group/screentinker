'use strict';

// #146 hardening (Item A) — pruneStatusLog must be per-device, chunked, non-blocking,
// band-gated, and re-entrant. The old whole-table ROW_NUMBER sort blocked the loop
// 40-48s on the 1.1M-row incident table (the death-spiral amplifier). Deterministic,
// in-process.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-pruneharden-' + crypto.randomBytes(4).toString('hex'));
process.env.STATUS_LOG_RETENTION_DAYS = '3';
process.env.STATUS_LOG_MAX_ROWS_PER_DEVICE = '500';
process.env.STATUS_LOG_PRUNE_BATCH = '2000';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, pruneStatusLog } = require('../db/database');
const chunked = require('../lib/chunked-prune');

function seed(deviceId, n, ageSecFn) {
  const ins = db.prepare('INSERT INTO device_status_log (device_id, status, timestamp) VALUES (?, ?, ?)');
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction((count) => {
    for (let i = 0; i < count; i++) ins.run(deviceId, i % 2 ? 'online' : 'offline', now - ageSecFn(i));
  });
  tx(n);
}
const count = (d) => db.prepare('SELECT COUNT(*) c FROM device_status_log' + (d ? ' WHERE device_id = ?' : '')).get(...(d ? [d] : [])).c;

test('correctness: keeps newest cap per device, drops older-than-retention, devices independent', async () => {
  db.exec('DELETE FROM device_status_log');
  chunked.__setBandForTest(() => 'normal');
  // device A: 800 recent rows -> cap keeps newest 500
  seed('A', 800, () => 0);
  // device B: 300 recent (< cap, all kept) + 50 older-than-retention (dropped)
  seed('B', 300, () => 0);
  seed('B', 50, () => 10 * 86400);
  // device C: 10 rows, all old -> all dropped
  seed('C', 10, () => 10 * 86400);

  await pruneStatusLog();

  assert.equal(count('A'), 500, 'A capped to newest 500');
  assert.equal(count('B'), 300, 'B keeps its 300 recent, drops the 50 old');
  assert.equal(count('C'), 0, 'C all older than retention -> gone');
  const cutoff = Math.floor(Date.now() / 1000) - 3 * 86400;
  assert.ok(db.prepare('SELECT MIN(timestamp) m FROM device_status_log').get().m >= cutoff, 'nothing older than retention survives');
});

test('non-blocking: 300k-row single-device backlog trims in many batches, loop stays responsive', async () => {
  db.exec('DELETE FROM device_status_log');
  chunked.__setBandForTest(() => 'normal');
  seed('flapper', 300000, () => 0);              // all recent -> cap prune must remove ~299500
  assert.equal(count('flapper'), 300000, 'seeded 300k');

  // Event-loop responsiveness probe: a 10ms ticker; the max gap between ticks is the
  // worst synchronous block during the prune. A single unbatched DELETE would freeze
  // it for seconds; chunked+yield keeps every gap small.
  let maxGap = 0, last = Date.now();
  const ticker = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 10);

  const deleted = await pruneStatusLog();
  clearInterval(ticker);

  assert.equal(count('flapper'), 500, 'trimmed to the cap');
  assert.ok(deleted >= 299000, `deleted the backlog (${deleted})`);
  assert.ok(maxGap < 250, `no long freeze — max event-loop gap ${maxGap}ms (would be seconds if unbatched)`);
});

test('band-gate: interval run is a no-op when loaded; startup/normal runs', async () => {
  db.exec('DELETE FROM device_status_log');
  seed('X', 900, () => 0);

  chunked.__setBandForTest(() => 'critical');
  assert.equal(await pruneStatusLog({ bandGate: true }), 0, 'band-gated interval run skips while critical');
  assert.equal(count('X'), 900, 'no rows touched while loaded');

  // startup path is NOT band-gated even under load
  assert.ok(await pruneStatusLog({ bandGate: false }) > 0, 'un-gated startup run trims even while critical');
  assert.equal(count('X'), 500, 'startup cleared the backlog to cap');

  chunked.__setBandForTest(() => 'normal');
});

test('re-entrancy: two concurrent runs -> work happens once', async () => {
  db.exec('DELETE FROM device_status_log');
  chunked.__setBandForTest(() => 'normal');
  seed('Y', 5000, () => 0);

  const [a, b] = await Promise.all([pruneStatusLog(), pruneStatusLog()]);   // fired synchronously
  assert.ok((a > 0) !== (b > 0), 'exactly one run did the work; the other short-circuited to 0');
  assert.equal(count('Y'), 500, 'trimmed to cap exactly once (no double-run corruption)');
});
