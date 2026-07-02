'use strict';

// #146 hardening (Item E) — log/write self-protection. The coalescer collapses N
// identical high-frequency lines into ONE summarized line, and its buffer is bounded.
// The content-ack limiter's per-device Map is now swept (no unbounded growth).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-logself-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const coalescer = require('../lib/log-coalescer');
const contentAck = require('../lib/content-ack-limiter');

function capture(fn) {
  const lines = [];
  const rl = console.log, rw = console.warn;
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.log = rl; console.warn = rw; }
  return lines;
}

test('N identical lines in a window emit ONE summarized line with the count', () => {
  coalescer.reset();
  for (let i = 0; i < 47; i++) coalescer.record('loop-lag:critical', '[loop-lag] band=critical p99=1502ms');
  const out = capture(() => coalescer.flush());
  assert.equal(out.length, 1, 'coalesced to a single line');
  assert.match(out[0], /x47/, 'shows the count');
  assert.match(out[0], /band=critical/, 'keeps the sample text');
});

test('P3.7: coalesced numeric line carries the PEAK over the window, not a random sample', () => {
  coalescer.reset();
  coalescer.record('lag', '[loop-lag] band=critical', { peak: 300, peakUnit: 'ms' });
  coalescer.record('lag', '[loop-lag] band=critical', { peak: 1502, peakUnit: 'ms' });
  coalescer.record('lag', '[loop-lag] band=critical', { peak: 900, peakUnit: 'ms' });
  const out = capture(() => coalescer.flush());
  assert.equal(out.length, 1);
  assert.match(out[0], /x3/);
  assert.match(out[0], /peak 1502ms/, 'emits the MAX p99 over the window');
});

test('a single occurrence logs verbatim (no count suffix)', () => {
  coalescer.reset();
  coalescer.record('k', 'one-off line');
  const out = capture(() => coalescer.flush());
  assert.deepEqual(out, ['one-off line']);
});

test('buffer stays BOUNDED under a flood of distinct keys (auto-flush at cap)', () => {
  coalescer.reset();
  capture(() => { for (let i = 0; i < 5000; i++) coalescer.record('key-' + i, 'line ' + i); });
  assert.ok(coalescer._size() <= 500, `buffer bounded (<=500), was ${coalescer._size()}`);
});

test('content-ack limiter Map is swept of idle buckets (no unbounded growth)', () => {
  contentAck.reset();
  const now = 0;
  contentAck.check('dev-a', 'c1', 'ready', 'normal', now);
  contentAck.check('dev-b', 'c1', 'ready', 'normal', now);
  assert.ok(contentAck._size() >= 2);
  const swept = contentAck.sweep(10 * 300000);   // far past the idle window
  assert.ok(swept >= 2, 'idle buckets evicted');
  assert.equal(contentAck._size(), 0, 'map drained');
});
