'use strict';
// #146 hardening (Item B) — sustained per-identity connection-frequency limiter, the
// TRIGGER fix. Complements (does not replace) the #142 burst throttle: that trips at
// reconnectBaseMax/reconnectWindowMs (5/10s); this catches a device flapping every
// 3-5s (~2-3/10s, which passes the burst throttle) over a LONG window
// (connectRateWindowMs, default 5min / connectRateMax, default 20).
//
// Keyed via the SNAT-safe identity fallback chain (device-identity.js) — device_id ->
// fingerprint -> device_token -> ONE global anon bucket. NEVER IP. Checked at the
// device:register gate BEFORE any heavy work (playlist build / acks / DB writes), so a
// refusal is cheap. Over the limit -> refuse with a backoff notice + disconnect.
//
// In-memory is acceptable BECAUSE Item A ends the prune-induced restart loop that used
// to wipe this state every ~40s before it could bite. Bounded: an idle sweep evicts
// stale buckets and the anonymous fallback is a single shared bucket (an anon flood is
// capped collectively, never one-bucket-per-attacker growth).
//
// #146 P0: a hard flapper (connectRateQuarantineTrips trips in a window) is QUARANTINED
// in-memory for connectRateQuarantineMs — a cheap, auto-clearing refusal, NOT a DB block.
// The devices.blocked column is the operator's deliberate, durable lever and is never
// written automatically.

const config = require('../config');
const { ANON_KEY } = require('./device-identity');

// key -> { hits: number[], blockedUntil, lastSeen, trips, tripWinStart, quarantinedUntil }
const state = new Map();

function maxFor(key) { return key === ANON_KEY ? config.connectRateAnonMax : config.connectRateMax; }

// Decide whether to allow this connection for `key`. Returns
//   { allow: true }
//   { allow: false, retryAfterMs, reason, tripped?, trips?, quarantined? }
// reason: 'quarantined' (in-memory time-limited), 'flap-cooldown' (post-trip), 'flap-rate'
// (the trip edge). `quarantined:true` marks the START of a quarantine (log once).
function check(key, now = Date.now()) {
  let s = state.get(key);
  if (!s) { s = { hits: [], blockedUntil: 0, lastSeen: now, trips: 0, tripWinStart: now, quarantinedUntil: 0 }; state.set(key, s); }
  s.lastSeen = now;

  // #146 P0: quarantine is an IN-MEMORY, TIME-LIMITED refusal that AUTO-CLEARS — never a
  // DB block. A stuck-then-recovered device comes back on its own after the window. This
  // is safe in-memory now that Item A ended the prune-induced restart loop; a
  // self-healing auto-action must NOT survive as a devices.blocked row.
  if (now < s.quarantinedUntil) {
    return { allow: false, retryAfterMs: s.quarantinedUntil - now, reason: 'quarantined' };
  }

  // Inside an enforced cooldown -> refuse cheaply.
  if (now < s.blockedUntil) {
    return { allow: false, retryAfterMs: s.blockedUntil - now, reason: 'flap-cooldown' };
  }

  // Sliding window of genuine connects.
  s.hits = s.hits.filter((t) => now - t < config.connectRateWindowMs);
  s.hits.push(now);

  if (s.hits.length > maxFor(key)) {
    s.blockedUntil = now + config.connectRateCooldownMs;   // cooldown; a fresh burst must re-accumulate
    s.hits = [];
    if (now - s.tripWinStart > config.connectRateWindowMs) { s.tripWinStart = now; s.trips = 0; }
    s.trips += 1;
    // Escalate to a time-limited quarantine after N trips in the window (0 = off).
    if (config.connectRateQuarantineTrips > 0 && s.trips >= config.connectRateQuarantineTrips) {
      s.quarantinedUntil = now + config.connectRateQuarantineMs;
      return { allow: false, retryAfterMs: config.connectRateQuarantineMs, reason: 'flap-rate', tripped: true, trips: s.trips, quarantined: true };
    }
    return { allow: false, retryAfterMs: config.connectRateCooldownMs, reason: 'flap-rate', tripped: true, trips: s.trips };
  }
  return { allow: true };
}

// #146: evict idle buckets so keyed state can't grow unbounded over churned identities.
function sweep(now = Date.now()) {
  let n = 0;
  for (const [k, s] of state) if (k !== ANON_KEY && now - s.lastSeen > config.connectRateIdleMs) { state.delete(k); n++; }
  if (n > 0) console.log(`[flap] swept ${n} idle bucket(s); ${state.size} remain`);
  return n;
}
let sweepTimer = null;
function startSweep() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => sweep(), config.connectRateIdleMs);
  if (sweepTimer.unref) sweepTimer.unref();
  return sweepTimer;
}

function reset() { state.clear(); }        // tests
function _size() { return state.size; }
module.exports = { check, sweep, startSweep, reset, _size };
