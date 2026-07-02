'use strict';

// #146 observability — throughput counters on /api/status.debug. The shared rolling
// counter + each subsystem's total/lastWindow increment on the right event.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-thru-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rollingCounter, bump, read } = require('../lib/rolling-counter');
const flap = require('../lib/flap-limiter');
const breaker = require('../lib/ota-breaker');
const guard = require('../lib/ota-download-guard');
const config = require('../config');

test('rolling-counter: total accrues; lastWindow = last CLOSED window; idle decays to 0', () => {
  const c = rollingCounter(1000);
  bump(c, 0); bump(c, 100); bump(c, 200);       // window 1: 3 hits in [0,1000)
  let r = read(c, 300);
  assert.equal(r.total, 3);
  assert.equal(r.lastWindow, 0, 'still inside window 1 — no completed window yet');
  bump(c, 1100);                                 // rolls: lastWindow=3, curWindow=1
  r = read(c, 1200);
  assert.equal(r.total, 4);
  assert.equal(r.lastWindow, 3, 'lastWindow reflects window 1');
  r = read(c, 6000);                             // 2+ idle windows
  assert.equal(r.lastWindow, 0, 'no activity for 2+ windows -> lastWindow decays to 0');
});

test('flap: allow:false bumps refusedTotal; a quarantine start bumps quarantineStartsTotal', () => {
  const save = { max: config.connectRateMax, win: config.connectRateWindowMs, cd: config.connectRateCooldownMs, qt: config.connectRateQuarantineTrips, qm: config.connectRateQuarantineMs };
  Object.assign(config, { connectRateMax: 1, connectRateWindowMs: 100000, connectRateCooldownMs: 1, connectRateQuarantineTrips: 2, connectRateQuarantineMs: 100000 });
  flap.reset();
  try {
    flap.check('d:t', 0); flap.check('d:t', 1);   // 2nd exceeds max 1 -> trip1 (refused)
    let s = flap.stats(2);
    assert.ok(s.refusedTotal >= 1, 'a refusal bumped refusedTotal');
    assert.equal(s.quarantineStartsTotal, 0, 'no quarantine yet');
    flap.check('d:t', 3); flap.check('d:t', 4);   // past cooldown -> trip2 -> quarantine
    s = flap.stats(5);
    assert.equal(s.quarantineStartsTotal, 1, 'quarantine start counted (even though the gauge later decays)');
    assert.ok(s.refusedTotal >= 2, 'both refusals counted');
    assert.equal(typeof s.refusedLastWindow, 'number');
  } finally { Object.assign(config, { connectRateMax: save.max, connectRateWindowMs: save.win, connectRateCooldownMs: save.cd, connectRateQuarantineTrips: save.qt, connectRateQuarantineMs: save.qm }); flap.reset(); }
});

test('ota-breaker: a rate-backoff verdict bumps rateBackoffTotal', () => {
  breaker.reset();
  const before = breaker.stats(0).rateBackoffTotal;
  for (let i = 0; i < 6; i++) breaker.decide('1.8.1', '1.9.2-beta7', null, i);   // device=none flood > THRESHOLD
  const s = breaker.stats(10);
  assert.ok(s.rateBackoffTotal > before, `rate-backoff counted (${s.rateBackoffTotal})`);
  assert.equal(typeof s.rateBackoffLastWindow, 'number');
});

test('ota-download: a shed bumps shedTotal; a serve bumps servedTotal', () => {
  const s = guard.newState();
  guard.admit(s, 'critical');                    // shed
  assert.equal(s.shedTotal, 1);
  guard.admit(s, 'normal'); guard.admit(s, 'normal');
  assert.equal(s.servedTotal, 2, 'serves counted');
});

test('maintenance: sweepsTotal increments per completed prune', async () => {
  const { pruneStatusLog, getMaintenanceStats } = require('../db/database');
  require('../lib/chunked-prune').__setBandForTest(() => 'normal');
  const before = getMaintenanceStats().sweepsTotal;
  await pruneStatusLog({ bandGate: false });
  assert.equal(getMaintenanceStats().sweepsTotal, before + 1, 'a completed sweep bumped sweepsTotal');
});
