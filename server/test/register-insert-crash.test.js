'use strict';

// #146 scale-hardening — a DB error in the device:register provisioning INSERT must
// reject THAT device's registration, NOT throw out of the handler -> uncaughtException
// -> logFatalAndExit -> whole-server exit. Found in the alpha load test: client-chosen
// pairing codes collide by birthday paradox, the UNIQUE INSERT threw, and the server
// crash-LOOPED, dropping the entire fleet.
//
// Teeth: a process 'uncaughtException' listener captures any escaped throw. With the
// fix the array stays empty (the INSERT error is caught in-handler) and the colliding
// device gets device:auth-error while the server keeps serving. Neutralize the
// try/catch around the INSERT in deviceSocket.js and this test goes RED — the second
// (colliding) registration throws an uncaughtException.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-regcrash-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const http = require('node:http');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const setupDeviceSocket = require('../ws/deviceSocket');

let httpServer, io, base;
const uncaught = [];
const onUncaught = (e) => uncaught.push(e);

before(async () => {
  process.on('uncaughtException', onUncaught);   // capture escaped throws instead of dying
  httpServer = http.createServer();
  io = new Server(httpServer);
  setupDeviceSocket(io);
  await new Promise((r) => httpServer.listen(0, r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
});
after(() => {
  process.off('uncaughtException', onUncaught);
  try { io.close(); } catch { /* */ }
  try { httpServer.close(); } catch { /* */ }
});

const connect = () => ioClient(`${base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });

// Register with a payload; resolves the outcome (registered | authError | timeout).
function register(payload) {
  return new Promise((resolve) => {
    const s = connect();
    let done = false;
    const fin = (r) => { if (done) return; done = true; try { s.close(); } catch { /* */ } resolve(r); };
    s.on('connect', () => s.emit('device:register', payload));
    s.on('device:registered', (d) => fin({ registered: true, id: d.device_id }));
    s.on('device:auth-error', (e) => fin({ authError: true, error: e && e.error }));
    setTimeout(() => fin({ timeout: true }), 3000);
  });
}

const settle = () => new Promise((r) => setTimeout(r, 150));

test('pairing-code collision rejects the 2nd device, does NOT crash the server', async () => {
  const code = String(crypto.randomInt(100000, 1000000));
  const a = await register({ pairing_code: code });
  assert.ok(a.registered, 'first device with the code registers');

  // Same code again -> UNIQUE constraint on devices.pairing_code.
  const b = await register({ pairing_code: code });
  await settle();
  assert.ok(b.authError, 'the colliding 2nd registration is rejected (device:auth-error)');
  assert.equal(uncaught.length, 0, 'a collision must NOT raise an uncaughtException');

  // Server is still alive: a fresh unique registration still works.
  const c = await register({ pairing_code: String(crypto.randomInt(100000, 1000000)) });
  assert.ok(c.registered, 'server keeps serving after the collision');
  assert.equal(uncaught.length, 0, 'still no uncaughtException');
});

test('a general DB error in the register INSERT also rejects-one, not crash', async () => {
  // device_info.screen_width as an object makes better-sqlite3's bind throw a
  // DIFFERENT error than UNIQUE — proves the catch is error-type-agnostic.
  const r = await register({ pairing_code: String(crypto.randomInt(100000, 1000000)), device_info: { screen_width: {} } });
  await settle();
  assert.ok(r.authError || r.timeout, 'the bad-bind registration is rejected, not completed');
  assert.equal(uncaught.length, 0, 'a general DB/bind error must NOT raise an uncaughtException');

  // Server still serving.
  const ok = await register({ pairing_code: String(crypto.randomInt(100000, 1000000)) });
  assert.ok(ok.registered, 'server keeps serving after a general register error');
  assert.equal(uncaught.length, 0, 'still no uncaughtException');
});
