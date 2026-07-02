'use strict';

// #146 scale-hardening — protectSocket() narrows fail-fast from whole-PROCESS to
// single-CONNECTION. A throwing socket handler must disconnect ONLY that socket and
// leave the server + every other socket fully alive — instead of escalating to
// uncaughtException -> process exit -> fleet outage (the alpha load-test crash).
//
// Teeth: an 'uncaughtException' capture asserts no throw escaped; client B proves the
// server kept serving. Swap protectSocket() for a raw socket.on (mutation) and this
// goes RED — the throw becomes an uncaughtException and socket A is never disconnected.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const { protectSocket } = require('../lib/safe-socket');

let httpServer, io, base;
const uncaught = [];
const onUncaught = (e) => uncaught.push(e);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  process.on('uncaughtException', onUncaught);
  httpServer = http.createServer();
  io = new Server(httpServer);
  io.of('/t').on('connection', (socket) => {
    protectSocket(socket, () => socket.id);          // <-- the fix under test
    socket.on('boom', () => { throw new Error('handler blew up'); });
    socket.on('ping', (data, ack) => { if (ack) ack('pong'); });
  });
  await new Promise((r) => httpServer.listen(0, r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
});
after(() => {
  process.off('uncaughtException', onUncaught);
  try { io.close(); } catch { /* */ }
  try { httpServer.close(); } catch { /* */ }
});

const connect = () => ioClient(`${base}/t`, { transports: ['websocket'], reconnection: false, forceNew: true });
const onceConnected = (s) => new Promise((r) => s.on('connect', r));

test('a throwing handler disconnects only that socket; server + other sockets survive', async () => {
  const A = connect(), B = connect();
  await Promise.all([onceConnected(A), onceConnected(B)]);

  let aGotError = false;
  A.on('server:error', (m) => { if (m && m.event === 'boom') aGotError = true; });
  const aDisconnected = new Promise((r) => A.on('disconnect', () => r(true)));

  // Sanity: B works before the boom.
  const pre = await new Promise((r) => B.emit('ping', {}, r));
  assert.equal(pre, 'pong', 'B responsive before the throw');

  // A triggers a handler throw.
  A.emit('boom', {});
  const dropped = await Promise.race([aDisconnected, sleep(2000).then(() => false)]);

  assert.equal(dropped, true, 'the throwing socket (A) is disconnected');
  assert.equal(uncaught.length, 0, 'no uncaughtException escaped to the process');

  // The server is still up and a DIFFERENT socket is unaffected.
  const post = await new Promise((r) => B.emit('ping', {}, r));
  assert.equal(post, 'pong', 'B still served after A threw — server survived');
  assert.ok(aGotError, 'A was told via server:error before being dropped');

  try { B.close(); } catch { /* */ }
});
