'use strict';

// #143 — deterministic unit tests for the folded content-ack limiter (dedup +
// per-device rate budget + global critical-lag valve). Injected `now`/`band`, no
// sockets. DATA_DIR set before require so config's jwt-secret write goes to a temp
// dir (not the repo). Rate params pinned via env for clarity.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-ack143-' + crypto.randomBytes(4).toString('hex'));
process.env.CONTENT_ACK_MAX_PER_WINDOW = '5';
process.env.CONTENT_ACK_RATE_WINDOW_MS = '10000';
process.env.CONTENT_ACK_DEDUP_MS = '2000';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const limiter = require('../lib/content-ack-limiter');

const T0 = 1_000_000;
beforeEach(() => limiter.reset());

function tally(results) {
  const t = { pass: 0, dedup: 0, 'shed-rate': 0, 'shed-valve': 0, logStarts: 0 };
  for (const r of results) { t[r.action]++; if (r.logStart) t.logStarts++; }
  return t;
}

test('#143 REGRESSION: cycling 2-4 DIFFERENT content ids (evading dedup) IS rate-limited', () => {
  // 4 ids, spaced 600ms so each id repeats every 2400ms (> 2000ms dedup) -> dedup
  // never fires (the exact case it misses), so the RATE budget must cap them.
  const ids = ['a', 'b', 'c', 'd'];
  const out = [];
  for (let i = 0; i < 12; i++) out.push(limiter.check('dev', ids[i % 4], 'ready', 'normal', T0 + i * 600));
  const t = tally(out);
  assert.equal(t.dedup, 0, 'dedup must NOT mask the cycling flood (proves rate limiter is what caps)');
  assert.equal(t.pass, 5, 'first MAX(5) pass');
  assert.equal(t['shed-rate'], 7, 'the remaining 7 are rate-shed');
  assert.equal(t.logStarts, 1, 'shedding logged exactly once per device per window');
});

test('unique ids (dedup never matches): under budget passes, over budget sheds', () => {
  const out = [];
  for (let i = 0; i < 8; i++) out.push(limiter.check('dev', 'u' + i, 'ready', 'normal', T0 + i * 10));
  const t = tally(out);
  assert.equal(t.pass, 5);
  assert.equal(t['shed-rate'], 3);
});

test('a device exactly at budget passes every ack', () => {
  for (let i = 0; i < 5; i++) {
    const v = limiter.check('dev', 'u' + i, 'ready', 'normal', T0 + i * 10);
    assert.equal(v.action, 'pass', `ack ${i + 1} (<=budget) passes`);
  }
});

test('dedup still works AND does not consume rate budget (no regression)', () => {
  assert.equal(limiter.check('dev', 'a', 'ready', 'normal', T0).action, 'pass');         // count 1
  assert.equal(limiter.check('dev', 'a', 'ready', 'normal', T0 + 100).action, 'dedup');  // repeat -> dedup
  assert.equal(limiter.check('dev', 'a', 'ready', 'normal', T0 + 200).action, 'dedup');  // repeat -> dedup
  // budget should still have 4 left (the 2 dedups didn't count): 4 distinct pass, 5th sheds
  for (const id of ['b', 'c', 'd', 'e']) assert.equal(limiter.check('dev', id, 'ready', 'normal', T0 + 300).action, 'pass');
  assert.equal(limiter.check('dev', 'f', 'ready', 'normal', T0 + 300).action, 'shed-rate', 'budget consumed only by non-duplicates');
});

test('global valve: CRITICAL sheds an in-budget device; NORMAL leaves it untouched', () => {
  assert.equal(limiter.check('A', 'x', 'ready', 'critical', T0).action, 'shed-valve', 'critical sheds even under budget');
  assert.equal(limiter.check('B', 'x', 'ready', 'normal', T0).action, 'pass', 'normal-band healthy device is unaffected by the valve');
  // a healthy device under normal band is never valve-touched across many acks
  for (let i = 0; i < 5; i++) assert.equal(limiter.check('C', 'u' + i, 'ready', 'normal', T0 + i).action, 'pass');
});

test('over-budget rate shedding takes precedence over the valve', () => {
  let v;
  for (let i = 0; i < 6; i++) v = limiter.check('dev', 'u' + i, 'ready', 'critical', T0 + i);
  assert.equal(v.action, 'shed-rate', 'a flooding device reports rate shedding, not just valve');
});

test('window reset: count + shed-notified reset, so a new window logs shedding again', () => {
  for (let i = 0; i < 7; i++) limiter.check('dev', 'u' + i, 'ready', 'normal', T0 + i * 10); // sheds, logs once
  // next window (>10s later): fresh budget
  for (let i = 0; i < 5; i++) assert.equal(limiter.check('dev', 'w' + i, 'ready', 'normal', T0 + 11000 + i).action, 'pass');
  const v = limiter.check('dev', 'w9', 'ready', 'normal', T0 + 11000 + 100);
  assert.equal(v.action, 'shed-rate');
  assert.equal(v.logStart, true, 'shedding is logged once in the NEW window too');
});

test('per-device isolation: one device flooding does not shed another', () => {
  for (let i = 0; i < 10; i++) limiter.check('STORM', 'u' + i, 'ready', 'normal', T0 + i); // STORM sheds
  assert.equal(limiter.check('NEIGHBOR', 'x', 'ready', 'normal', T0 + 11).action, 'pass');
});
