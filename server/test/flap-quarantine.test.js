'use strict';

// #146 P0 — auto-quarantine is IN-MEMORY + TIME-LIMITED, never a DB block. It engages
// after N trips, refuses cheaply during the window, AUTO-CLEARS, and must NEVER write
// devices.blocked (that column is the operator's lever only).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-flapq-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
process.env.CONNECT_RATE_MAX = '2';
process.env.CONNECT_RATE_WINDOW_MS = '5000';
process.env.CONNECT_RATE_COOLDOWN_MS = '50';
process.env.CONNECT_RATE_QUARANTINE_TRIPS = '2';
process.env.CONNECT_RATE_QUARANTINE_MS = '50000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const flap = require('../lib/flap-limiter');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');

// --- unit: deterministic injected-time behaviour ---
test('quarantine engages after N trips, refuses cheaply, and AUTO-CLEARS', () => {
  flap.reset();
  const k = 'd:q';
  // trip 1: exceed max (2) -> trip, cooldown to 250
  flap.check(k, 0); flap.check(k, 100);
  let r = flap.check(k, 200);
  assert.equal(r.tripped, true); assert.ok(!r.quarantined, 'first trip is not yet a quarantine');
  // past cooldown, trip 2 -> QUARANTINE (trips=2)
  flap.check(k, 300); flap.check(k, 400);
  r = flap.check(k, 500);
  assert.equal(r.quarantined, true, 'quarantine engages on the Nth trip');
  assert.equal(r.allow, false);
  // during the window: cheap 'quarantined' refusal
  const during = flap.check(k, 2000);
  assert.equal(during.allow, false);
  assert.equal(during.reason, 'quarantined');
  // auto-clears once now passes quarantinedUntil (500 + 50000); old hits have aged out
  const after = flap.check(k, 51000);
  assert.equal(after.allow, true, 'quarantine auto-clears — device comes back on its own, no restart');
});

// --- integration: a flapping device is quarantined but devices.blocked stays 0 ---
let httpServer, io, base;
before(async () => {
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO devices (id, device_token, status, blocked) VALUES ('flap-dev', 'tok', 'offline', 0)").run();
  db.pragma('foreign_keys = ON');
  httpServer = http.createServer(); io = new Server(httpServer); setupDeviceSocket(io);
  await new Promise((r) => httpServer.listen(0, r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
});
after(() => { try { io.close(); } catch { /* */ } try { httpServer.close(); } catch { /* */ } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function reg() {
  return new Promise((resolve) => {
    const s = ioClient(`${base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
    let done = false; const fin = (r) => { if (done) return; done = true; try { s.close(); } catch { /* */ } resolve(r); };
    s.on('connect', () => s.emit('device:register', { device_id: 'flap-dev', device_token: 'tok' }));
    s.on('device:registered', () => fin({ registered: true }));
    s.on('device:throttled', (m) => fin({ throttled: true, reason: m && m.reason }));
    setTimeout(() => fin({ timeout: true }), 1500);
  });
}

test('a flapping device gets quarantined, but devices.blocked is NEVER auto-written', async () => {
  flap.reset();
  let throttled = 0;
  // two cooldown-separated bursts -> 2 trips -> quarantine
  for (let burst = 0; burst < 2; burst++) {
    for (let i = 0; i < 3; i++) { const r = await reg(); if (r.throttled) throttled++; }
    await sleep(80);   // let the short cooldown expire so the next burst counts as a fresh trip
  }
  // a final attempt should now be refused by the quarantine
  const q = await reg();
  assert.ok(throttled >= 1 || q.throttled, 'the flapper was refused (flap/quarantine bit)');

  const row = db.prepare("SELECT blocked FROM devices WHERE id = 'flap-dev'").get();
  assert.equal(row.blocked, 0, 'auto-quarantine NEVER wrote devices.blocked — operator lever untouched');
});
