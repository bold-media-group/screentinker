'use strict';

// #142 step 2 — deterministic unit tests for the event-loop-lag band transitions.
// Pure function, no sockets/timing. Isolate the DB to a temp dir BEFORE requiring
// the module (requiring it pulls in db/database, which initialises a DB on load).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-lag-unit-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nextBand } = require('../services/loop-lag');

// config defaults exercised here: elevated=100ms, critical=250ms, releaseSamples=5,
// deadband=0.5 -> release-below thresholds: elevated@50ms, critical@125ms.

test('UP is immediate and can skip a level (tighten fast)', () => {
  assert.deepEqual(nextBand('normal', 50, 0), ['normal', 0], 'below elevated stays normal');
  assert.deepEqual(nextBand('normal', 100, 0), ['elevated', 0], 'crossing elevated up-threshold jumps immediately');
  assert.deepEqual(nextBand('normal', 250, 0), ['critical', 0], 'a big spike jumps normal->critical in one sample');
  assert.deepEqual(nextBand('elevated', 250, 0), ['critical', 0]);
});

test('deadband holds the band for small fluctuations (no flap)', () => {
  // elevated, p99 between release(50) and up(100) -> hold elevated, calm reset
  assert.deepEqual(nextBand('elevated', 80, 3), ['elevated', 0]);
  // critical, p99 between release(125) and up(250) -> hold critical
  assert.deepEqual(nextBand('critical', 200, 4), ['critical', 0]);
});

test('DOWN is slow: requires lagReleaseSamples calm samples below the deadband', () => {
  // elevated -> normal only after 5 consecutive calm samples
  let band = 'elevated', calm = 0;
  for (let i = 0; i < 4; i++) {
    [band, calm] = nextBand(band, 20, calm);
    assert.equal(band, 'elevated', `still elevated after ${i + 1} calm sample(s)`);
  }
  [band, calm] = nextBand(band, 20, calm); // 5th
  assert.deepEqual([band, calm], ['normal', 0], 'drops to normal on the 5th calm sample');
});

test('DOWN releases one level at a time: critical -> elevated -> normal', () => {
  let band = 'critical', calm = 0;
  for (let i = 0; i < 5; i++) [band, calm] = nextBand(band, 10, calm);
  assert.equal(band, 'elevated', 'critical releases to elevated, never straight to normal');
  for (let i = 0; i < 5; i++) [band, calm] = nextBand(band, 10, calm);
  assert.equal(band, 'normal', 'then elevated releases to normal');
});

test('a single calm sample does not release (calm counter resets on a non-calm sample)', () => {
  let [band, calm] = nextBand('elevated', 20, 0); // calm=1
  assert.deepEqual([band, calm], ['elevated', 1]);
  [band, calm] = nextBand(band, 80, calm); // back inside deadband -> reset
  assert.deepEqual([band, calm], ['elevated', 0], 'one blip resets the release counter');
});
