'use strict';

// #142 step 4 — global device_status_log retention sweep. Deterministic, in-process
// (no server/port). Isolate the DB and set retention BEFORE requiring the module
// (config reads env at load; database.js initialises a DB on load).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-statusprune-' + crypto.randomBytes(4).toString('hex'));
process.env.STATUS_LOG_RETENTION_DAYS = '2';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, pruneStatusLog } = require('../db/database');

test('global sweep deletes rows older than retention across ALL devices, keeps recent', async () => {
  db.exec('DELETE FROM device_status_log'); // clean slate
  const old = db.prepare("INSERT INTO device_status_log (device_id, status, timestamp) VALUES (?, ?, strftime('%s','now') - ?)");

  // 5 days old (> 2d retention): an active device, a device NOT in the devices
  // table (removed/idle — what the per-device insert-time prune never revisits),
  // and the heartbeat offline_timeout status that bypasses logDeviceStatus.
  old.run('live-dev', 'online', 5 * 86400);
  old.run('removed-idle-dev', 'offline', 5 * 86400);
  old.run('hb-dev', 'offline_timeout', 5 * 86400);
  // recent (< retention): must survive, regardless of device existence / status.
  old.run('live-dev', 'online', 0);
  old.run('hb-dev', 'offline_timeout', 3600);

  assert.equal(db.prepare('SELECT COUNT(*) c FROM device_status_log').get().c, 5, 'seeded 5 rows');

  const deleted = await pruneStatusLog();
  assert.equal(deleted, 3, 'the 3 over-retention rows pruned (incl. removed-idle + offline_timeout paths)');

  const remaining = db.prepare('SELECT device_id, status FROM device_status_log ORDER BY device_id').all();
  assert.equal(remaining.length, 2);
  // both survivors are the recent rows; no old row of any device/status survived
  assert.deepEqual(remaining.map(r => r.device_id).sort(), ['hb-dev', 'live-dev']);
  const oldestNow = db.prepare("SELECT MIN(timestamp) m FROM device_status_log").get().m;
  const cutoff = Math.floor(Date.now() / 1000) - 2 * 86400;
  assert.ok(oldestNow >= cutoff, 'no surviving row is older than the retention cutoff');
});

test('sweep is safe and idempotent on an empty/already-clean table', async () => {
  db.exec('DELETE FROM device_status_log');
  assert.equal(await pruneStatusLog(), 0, 'nothing to delete -> 0, no throw');
});
