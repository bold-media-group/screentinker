'use strict';
// #146 scale-hardening — narrow fail-fast from whole-PROCESS to single-CONNECTION.
//
// The process INTENTIONALLY fail-fasts on an uncaught throw (server.js logFatalAndExit:
// "after an uncaught throw the process state is undefined, so we never keep serving").
// For a per-DEVICE socket handler that blast radius is wrong: one device's bad input —
// a DB error inside a handler — threw out of the handler -> uncaughtException ->
// logFatalAndExit -> the WHOLE server exited and EVERY device dropped (found in the
// alpha load test: a colliding pairing code crash-LOOPED the fleet).
//
// protectSocket() overrides socket.on for ONE connection so every handler is wrapped.
// On a throw it does NOT keep serving that connection from possibly-half-mutated state
// (that would defeat the fail-fast intent); it logs (event + id + stack), tells the
// socket, and DISCONNECTS just that socket — which reconnects clean, a non-event after
// the beta5 reconnect fixes. So fail-fast becomes per-CONNECTION instead of
// whole-PROCESS. Per-site try/catch (e.g. the device:register INSERT) stays the primary
// guard; this is the backstop — and because it wraps socket.on itself, any FUTURE
// handler is covered automatically (no per-site swap to forget).
//
// Only socket.on is used in the ws layer (verified — no once/off/prependListener), so
// wrapping socket.on covers the whole handler surface for this connection.

function protectSocket(socket, ctxFn) {
  const rawOn = socket.on.bind(socket);
  socket.on = (event, handler) => rawOn(event, (...args) => {
    try {
      const r = handler(...args);
      // No handler is async today; if one becomes a promise, contain a rejection the
      // same way instead of letting it become an unhandledRejection -> exit.
      if (r && typeof r.then === 'function') r.catch((e) => bail(socket, event, e, ctxFn));
    } catch (e) {
      bail(socket, event, e, ctxFn);
    }
  });
  return socket;
}

function bail(socket, event, err, ctxFn) {
  let who = socket.id;
  try { const c = ctxFn && ctxFn(); if (c) who = `${c} (${socket.id})`; } catch (_) { /* ctx must never re-throw */ }
  console.error(`[socket:${event}] handler threw for ${who} — disconnecting this socket (server stays up):\n${(err && err.stack) || err}`);
  try { socket.emit('server:error', { event, error: 'internal error, please reconnect' }); } catch (_) { /* */ }
  // nextTick disconnect so the error notice flushes before the transport closes
  // (same pattern as the reconnect-throttle throttled-disconnect).
  process.nextTick(() => { try { socket.disconnect(true); } catch (_) { /* */ } });
}

module.exports = { protectSocket };
