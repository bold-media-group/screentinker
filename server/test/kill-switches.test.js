'use strict';

// #146 P1.3 — every new subsystem must be disable-able via env WITHOUT a code change, so
// a misfire on alpha is an env flip + restart (no redeploy). The libs read config.* at
// CALL time, so these tests flip the resolved config value at runtime (equivalent to the
// env being set) and assert the OFF behaviour.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-kill-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const flap = require('../lib/flap-limiter');
const guard = require('../lib/ota-download-guard');
const chunked = require('../lib/chunked-prune');
const { db, pruneStatusLog } = require('../db/database');

test('FLAP_LIMITER_ENABLED=false -> flap limiter always allows', () => {
  flap.reset();
  config.flapLimiterEnabled = false;
  try { for (let i = 0; i < 1000; i++) assert.equal(flap.check('d:x', i).allow, true); }
  finally { config.flapLimiterEnabled = true; }
});

test('OTA_DOWNLOAD_GUARD_ENABLED=false -> download guard always admits (even critical)', () => {
  config.otaDownloadGuardEnabled = false;
  try {
    const s = guard.newState();
    for (let i = 0; i < 50; i++) assert.equal(guard.admit(s, 'critical').allow, true, 'disabled -> allow even under critical');
    assert.equal(s.shed, 0);
  } finally { config.otaDownloadGuardEnabled = true; }
});

test('CONNECT_RATE_QUARANTINE_TRIPS=0 -> never quarantines (only cools down)', () => {
  flap.reset();
  const orig = { trips: config.connectRateQuarantineTrips, max: config.connectRateMax, cd: config.connectRateCooldownMs };
  config.connectRateQuarantineTrips = 0; config.connectRateMax = 1; config.connectRateCooldownMs = 1;
  try {
    let quarantined = false, now = 0;
    for (let t = 0; t < 20; t++) {              // many trips
      flap.check('d:q0', now); const r = flap.check('d:q0', now + 1);   // 2 hits > max 1 -> trip
      if (r.quarantined) quarantined = true;
      now += 100;                               // past the 1ms cooldown
    }
    assert.equal(quarantined, false, 'trips=0 disables quarantine');
  } finally { Object.assign(config, { connectRateQuarantineTrips: orig.trips, connectRateMax: orig.max, connectRateCooldownMs: orig.cd }); }
});

test('MAINTENANCE_BAND_GATE_ENABLED=false -> interval prune runs even under load', async () => {
  db.exec('DELETE FROM device_status_log');
  const ins = db.prepare("INSERT INTO device_status_log (device_id, status, timestamp) VALUES ('d', 'online', ?)");
  const oldTs = Math.floor(Date.now() / 1000) - 10 * 86400;   // older than retention
  for (let i = 0; i < 10; i++) ins.run(oldTs);

  chunked.__setBandForTest(() => 'critical');
  // sanity: with the band-gate ON, a band-gated run is a no-op under critical
  assert.equal(await pruneStatusLog({ bandGate: true }), 0, 'gate ON -> skipped while critical');

  config.maintenanceBandGateEnabled = false;
  try {
    const deleted = await pruneStatusLog({ bandGate: true });
    assert.ok(deleted > 0, 'gate OFF -> maintenance runs even under critical');
  } finally { config.maintenanceBandGateEnabled = true; chunked.__setBandForTest(() => 'normal'); }
});
