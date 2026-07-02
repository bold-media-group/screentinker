'use strict';

// #146 cause-1 — the evicted-socket offline-timer RE-ARM race, test-PROVEN.
//
// This is the subtler/primary false-offline cause. In the register handler,
// evictPriorSocket() runs BEFORE registerConnection() puts the NEW socket in the
// connection map. So when the evicted OLD socket's 'disconnect' fires, the map still
// points at the old socket, the stale-disconnect guard passes, and (pre-fix) it ARMS
// a fresh 5s offline timer — for a device that just reconnected. Under loop-lag that
// timer fires before the new socket's registerConnection lands and marks a live,
// just-reconnected screen offline. The fix tags the evicted socket id so its
// disconnect handler bails instead of arming a timer.
//
// In-process (not a spawned server) so we can inspect deviceSocket's internal
// pendingOfflines/evictedSockets via the __ test hooks. Neutralize the
// `if (evictedSockets.delete(socket.id)) return;` line in deviceSocket.js and this
// test goes RED (a pending offline timer survives the reconnect) — same teeth
// standard as the cause-2 mutation check.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Isolate the DB BEFORE requiring config/database (they read env at load time).
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-evict-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const http = require('node:http');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const setupDeviceSocket = require('../ws/deviceSocket');

let httpServer, io, base;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  httpServer = http.createServer();
  io = new Server(httpServer);
  setupDeviceSocket(io);
  await new Promise((r) => httpServer.listen(0, r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
});

after(() => {
  try { setupDeviceSocket.__resetTimers(); } catch { /* */ }
  try { io.close(); } catch { /* */ }
  try { httpServer.close(); } catch { /* */ }
});

const connect = () => ioClient(`${base}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });

function provision() {
  const code = String(crypto.randomInt(100000, 1000000));
  return new Promise((resolve) => {
    const s = connect();
    s.on('connect', () => s.emit('device:register', { pairing_code: code }));
    s.on('device:registered', (d) => resolve({ sock: s, id: d.device_id, token: d.device_token }));
    setTimeout(() => resolve(null), 3000);
  });
}

// Register an existing device on a fresh socket (the genuine-reconnect path that
// triggers evictPriorSocket). Resolves true on device:registered.
function registerOn(sock, dev) {
  return new Promise((resolve) => {
    sock.on('device:registered', () => resolve(true));
    sock.on('connect', () => sock.emit('device:register',
      { device_id: dev.id, device_token: dev.token, device_info: { app_version: 'test' } }));
    setTimeout(() => resolve(false), 3000);
  });
}

test('cause-1: a reconnect that evicts the prior socket leaves NO surviving offline timer', async () => {
  const dev = await provision();
  assert.ok(dev, 'provisioned');
  dev.sock.close();                 // drop the provisioning socket
  await sleep(120);

  // socket1 becomes the established live connection. Its register also clears any
  // pending-offline left by the provisioning socket's disconnect -> clean baseline.
  const s1 = connect();
  assert.ok(await registerOn(s1, dev), 'socket1 registered');
  await sleep(60);
  assert.equal(setupDeviceSocket.__pendingOfflineCount(), 0,
    'baseline: no offline timer pending after the first live registration');

  // socket2 reconnects for the SAME device -> evictPriorSocket disconnects socket1.
  // socket1's disconnect handler runs while the map still points at socket1 (the new
  // socket isn't registered yet) — the exact window the cause-1 fix must cover.
  const s2 = connect();
  assert.ok(await registerOn(s2, dev), 'socket2 registered (evicting socket1)');
  await sleep(300);                 // let socket1's eviction-disconnect process

  // THE PROOF: the evicted socket1 must NOT have armed an offline timer for a device
  // that is, right now, live on socket2. Pre-fix this is true (timer armed) -> red.
  assert.equal(setupDeviceSocket.__hasPendingOffline(dev.id), false,
    'no offline timer may survive the reconnect (cause-1 re-arm race)');

  // Lifecycle (a): the eviction flag self-drains on the evicted socket's disconnect,
  // so the set is bounded by in-flight evictions and cannot leak.
  assert.equal(setupDeviceSocket.__evictedSize(), 0,
    'evictedSockets self-drained once the evicted socket disconnected');

  s1.close(); s2.close();
});
