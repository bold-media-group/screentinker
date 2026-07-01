'use strict';

// #146 P2.5 — classify buildPlaylistPayload under a legitimate fleet-wide simultaneous
// reconnect (e.g. 230 disty devices after one network blip). Each first connect passes
// the flap/reconnect gates and runs buildPlaylistPayload SYNCHRONOUSLY. Measure the
// per-call cost with a large published_snapshot and confirm it stays well under the
// ~50ms invariant (the loop yields between socket.io handler invocations, so the risk is
// per-call, not one aggregate block).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-plcost-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');

let httpServer, io, buildPlaylistPayload;
before(async () => {
  httpServer = http.createServer(); io = new Server(httpServer); setupDeviceSocket(io);
  buildPlaylistPayload = setupDeviceSocket.buildPlaylistPayload;
  await new Promise((r) => httpServer.listen(0, r));

  // a realistically LARGE published snapshot: 200 items.
  const snap = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({
    content_id: 'c' + i, type: 'image', duration_sec: 10, url: '/uploads/content/c' + i + '.jpg', name: 'item ' + i,
  })));
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO playlists (id, user_id, name, status, published_snapshot) VALUES ('pl-big', 'u', 'Big', 'published', ?)").run(snap);
  db.prepare("INSERT INTO devices (id, status, playlist_id) VALUES ('perf-dev', 'online', 'pl-big')").run();
  db.pragma('foreign_keys = ON');
});
after(() => { try { io.close(); } catch { /* */ } try { httpServer.close(); } catch { /* */ } });

test('buildPlaylistPayload is synchronous and cheap enough for a fleet-wide reconnect', () => {
  assert.equal(typeof buildPlaylistPayload, 'function');
  const payload = buildPlaylistPayload('perf-dev');
  assert.equal(payload.assignments.length, 200, 'parsed the 200-item snapshot');

  // Warm, then measure per-call over a disty-scale fleet count.
  for (let i = 0; i < 50; i++) buildPlaylistPayload('perf-dev');
  const N = 230, times = [];
  for (let i = 0; i < N; i++) { const t = process.hrtime.bigint(); buildPlaylistPayload('perf-dev'); times.push(Number(process.hrtime.bigint() - t) / 1e6); }
  const max = Math.max(...times);
  const avg = times.reduce((a, b) => a + b, 0) / N;
  const aggregate = avg * N;
  console.log(`[P2.5] buildPlaylistPayload x${N}: avg=${avg.toFixed(3)}ms max=${max.toFixed(3)}ms aggregate=${aggregate.toFixed(1)}ms (spread across ${N} handler invocations, not one block)`);

  // Per-call is the real unit (socket.io yields between handlers) — must be far under 50ms.
  assert.ok(max < 50, `single build max ${max.toFixed(2)}ms < 50ms invariant`);
  assert.ok(avg < 5, `single build avg ${avg.toFixed(3)}ms is cheap`);
});
