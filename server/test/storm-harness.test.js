'use strict';

// #146 hardening — THE BULLETPROOF PROOF. Combine, all at once:
//   - a pre-bloated device_status_log (300k rows — the incident amplifier),
//   - a maintenance sweep running over it (the old whole-table sort froze 40-48s),
//   - a device flapping hard (the trigger),
//   - an OTA download flood from a single SNAT IP,
// and assert the event loop NEVER enters a multi-second freeze and the server stays
// responsive throughout (no NaN-sample block), while every limiter still bites.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-storm-' + crypto.randomBytes(4).toString('hex'));
process.env.STATUS_LOG_MAX_ROWS_PER_DEVICE = '500';
process.env.STATUS_LOG_PRUNE_BATCH = '2000';
process.env.STATUS_LOG_RETENTION_DAYS = '3';
process.env.CONNECT_RATE_MAX = '20';
process.env.OTA_DOWNLOAD_MAX_PER_WINDOW = '120';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db, pruneStatusLog } = require('../db/database');
const flap = require('../lib/flap-limiter');
const otaGuard = require('../lib/ota-download-guard');
const chunked = require('../lib/chunked-prune');

test('storm: bloated-table sweep + flapper + OTA flood — loop stays responsive, limiters bite', async () => {
  chunked.__setBandForTest(() => 'normal');
  flap.reset();

  // Pre-bloat: 300k rows across a few flapping devices (recent -> the cap prune must
  // remove ~299k+ of them).
  db.exec('DELETE FROM device_status_log');
  const ins = db.prepare('INSERT INTO device_status_log (device_id, status, timestamp) VALUES (?, ?, ?)');
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    for (let i = 0; i < 300000; i++) ins.run('dev-' + (i % 3), i % 2 ? 'online' : 'offline', now);
  })();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM device_status_log').get().c, 300000, 'seeded 300k');

  // Event-loop responsiveness probe: max gap between 10ms ticks = worst sync block.
  let maxGap = 0, last = Date.now(), ticks = 0;
  const ticker = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; ticks++; }, 10);

  // The amplifier sweep (chunked) runs concurrently with the storms below.
  const prunePromise = pruneStatusLog({ bandGate: false });

  // Flapper storm + OTA flood from ONE SNAT IP, driven in yielding rounds.
  let flapRefused = 0, otaShed = 0, otaServed = 0;
  const guardState = otaGuard.newState();
  const stormPromise = (async () => {
    for (let round = 0; round < 300; round++) {
      for (let i = 0; i < 40; i++) {
        if (!flap.check('d:storm-flapper').allow) flapRefused++;   // one hard flapper (identity-keyed, never IP)
        const a = otaGuard.admit(guardState, 'elevated');         // under load -> band-aware caps engage
        if (a.allow) { otaServed++; otaGuard.release(guardState); } else otaShed++;
      }
      await new Promise((r) => setImmediate(r));
    }
  })();

  const [deleted] = await Promise.all([prunePromise, stormPromise]);
  clearInterval(ticker);

  // 1) NO multi-second freeze — the old whole-table sort would freeze the ticker for
  //    tens of seconds here.
  assert.ok(maxGap < 300, `loop never froze — max event-loop gap ${maxGap}ms (was 40-48s pre-fix)`);
  assert.ok(ticks >= 10, `ticker kept firing through the storm (${ticks} ticks)`);
  // 2) The sweep actually drained the backlog to the cap.
  assert.ok(deleted >= 298000, `sweep trimmed the backlog (${deleted} deleted)`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM device_status_log').get().c, 1500, '3 devices x 500 cap');
  // 3) Every limiter still bit under load.
  assert.ok(flapRefused > 0, 'the flapper was refused (flap limiter bit)');
  assert.ok(otaShed > 0, 'the OTA flood was shed past the global window cap');
  assert.ok(otaServed <= 120, `OTA served capped at the window max (${otaServed})`);
});
