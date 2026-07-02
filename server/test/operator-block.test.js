'use strict';

// #146 hardening (Item D) — operator block kill switch. Enforced at the device:register
// handshake BEFORE throttle/DB/playlist. #146 fix: resolve identity via the fallback
// chain so a blocked device that reconnects WITHOUT a device_id (but with a mapped
// fingerprint) is STILL caught (the old `if (device_id)` gate let it slip). Unblock takes
// effect on the next register with NO restart. In-process.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-block-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');

let httpServer, io, base;
before(async () => {
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO devices (id, device_token, status, blocked) VALUES ('blk-dev', 'tok', 'offline', 1)").run();
  db.prepare("INSERT OR REPLACE INTO device_fingerprints (fingerprint, device_id) VALUES ('fp-blk', 'blk-dev')").run();
  db.pragma('foreign_keys = ON');
  httpServer = http.createServer();
  io = new Server(httpServer);
  setupDeviceSocket(io);
  await new Promise((r) => httpServer.listen(0, r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
});
after(() => { try { io.close(); } catch { /* */ } try { httpServer.close(); } catch { /* */ } });

const connect = () => ioClient(`${base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });

// register(payload) -> { authError, registered, gotPlaylist }
function register(payload) {
  return new Promise((resolve) => {
    const s = connect();
    let done = false, gotPlaylist = false;
    const fin = (r) => { if (done) return; done = true; try { s.close(); } catch { /* */ } resolve({ ...r, gotPlaylist }); };
    s.on('device:playlist-update', () => { gotPlaylist = true; });
    s.on('connect', () => s.emit('device:register', payload));
    s.on('device:auth-error', (e) => fin({ authError: e && e.error }));
    s.on('device:registered', () => setTimeout(() => fin({ registered: true }), 100));
    setTimeout(() => fin({ timeout: true }), 2000);
  });
}

test('a blocked device is refused at handshake, cheaply (no playlist build)', async () => {
  const r = await register({ device_id: 'blk-dev', device_token: 'tok' });
  assert.equal(r.authError, 'Device blocked', 'refused with the block error');
  assert.ok(!r.registered, 'never registered');
  assert.ok(!r.gotPlaylist, 'no playlist was built — short-circuited before heavy work');
});

test('a blocked device reconnecting WITHOUT device_id but with a mapped fingerprint is still refused', async () => {
  const r = await register({ fingerprint: 'fp-blk' });   // no device_id — resolves via device_fingerprints
  assert.equal(r.authError, 'Device blocked', 'caught via the fingerprint->device_id identity chain');
  assert.ok(!r.registered);
});

test('unblock takes effect on the NEXT register, no restart', async () => {
  db.prepare("UPDATE devices SET blocked = 0 WHERE id = 'blk-dev'").run();
  const r = await register({ device_id: 'blk-dev', device_token: 'tok' });
  assert.ok(r.registered, 'registers once unblocked — same running server, no restart');
  assert.ok(!r.authError);
});
