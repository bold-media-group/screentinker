'use strict';

// #146 hardening (Item C) — OTA under SNAT. Cached APK resolution (no per-request fs)
// + GLOBAL download admission (concurrency + rate + critical-band shed, never per-IP).

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-otahard-' + crypto.randomBytes(4).toString('hex'));
process.env.OTA_DOWNLOAD_MAX_CONCURRENT = '3';
process.env.OTA_DOWNLOAD_MAX_PER_WINDOW = '5';
process.env.OTA_DOWNLOAD_WINDOW_MS = '100000';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../lib/ota-download-guard');
const apkCache = require('../lib/apk-cache');

test('apk-cache: get() never touches the filesystem (resolution cached at boot/refresh)', () => {
  // seed a fake APK under DATA_DIR and refresh once
  const apk = path.join(process.env.DATA_DIR, 'ScreenTinker.apk');
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  fs.writeFileSync(apk, 'FAKEAPKBYTES');
  const c = apkCache.refresh();
  assert.equal(c.exists, true);
  assert.equal(c.size, 12);

  // count fs.statSync calls across many get()s -> must be ZERO (a poll/download flood
  // can't become a statSync flood).
  const realStat = fs.statSync; let calls = 0;
  fs.statSync = (...a) => { calls++; return realStat(...a); };
  try { for (let i = 0; i < 1000; i++) apkCache.get(); } finally { fs.statSync = realStat; }
  assert.equal(calls, 0, 'get() does no fs; 1000 reads = 0 statSync');
});

test('download guard: global concurrency cap -> 503 (not per-IP)', () => {
  const s = guard.newState();
  assert.equal(guard.admit(s, 'normal').allow, true);
  assert.equal(guard.admit(s, 'normal').allow, true);
  assert.equal(guard.admit(s, 'normal').allow, true);   // 3 in-flight = cap
  const over = guard.admit(s, 'normal');
  assert.equal(over.allow, false);
  assert.equal(over.status, 503);
  assert.ok(over.retryAfter > 0);
  guard.release(s);                                       // free one slot
  assert.equal(guard.admit(s, 'normal').allow, true, 'a freed slot admits again');
});

test('download guard: global per-window rate cap -> 503', () => {
  const s = guard.newState();
  for (let i = 0; i < 5; i++) { assert.equal(guard.admit(s, 'normal').allow, true); guard.release(s); } // 5 served this window
  const over = guard.admit(s, 'normal');
  assert.equal(over.allow, false, '6th in the window is shed');
  assert.equal(over.status, 503);
});

test('download guard: critical band sheds regardless of caps', () => {
  const s = guard.newState();
  const v = guard.admit(s, 'critical');
  assert.equal(v.allow, false);
  assert.equal(v.retryAfter, 30, 'critical band asks for a longer backoff');
});

test('download guard admission takes NO ip argument (global by construction)', () => {
  // admit(state, band, now) — there is no IP parameter, so it cannot key on IP.
  assert.equal(guard.admit.length <= 3, true);
  const s = guard.newState();
  assert.equal(guard.admit(s, 'normal').allow, true); // works with zero IP context
});
