// #143 — content-ack flood control (the single control on the content-ack path).
//
// Folds three concerns into ONE per-device limiter so there are no competing
// limiters on this path (reconnect-throttle.js is left untouched):
//   1. #142 dedup — drop an exact (content_id, status) repeat within the dedup
//      window. Legit repeat suppression; does NOT consume rate budget.
//   2. #143 per-device RATE budget — cap TOTAL non-duplicate acks per device per
//      window regardless of differing content_id. This is what dedup misses: a
//      device cycling 2-4 ids makes each ack look unique, so dedup never fires,
//      but aggregate volume still floods the loop. Over budget -> shed silently.
//   3. #143 global pressure valve — when loop-lag (services/loop-lag.js) reports
//      the CRITICAL band, shed non-essential acks even for a device within its own
//      budget. Reuses the existing band + hysteresis; never fires below critical.
//
// Per-device, in-memory, resets on restart (like lastPlayLogAt / pair-lockout).
// Fixed window (counter reset per window) — simple and makes "log once per window"
// natural. `band` is injected so this is testable without the loop-lag monitor.

const config = require('../config');

// deviceId -> { winStart, count, shedNotified, dup: Map(content|status -> ts) }
const state = new Map();

// Returns one of:
//   { action: 'pass' }                                  -> caller logs + emits
//   { action: 'dedup' }                                 -> drop (exact repeat)
//   { action: 'shed-rate', logStart, observed, budget } -> drop (over per-device budget)
//   { action: 'shed-valve' }                            -> drop (global critical-lag valve)
function check(deviceId, contentId, status, band = 'normal', now = Date.now()) {
  let s = state.get(deviceId);
  if (!s) { s = { winStart: now, count: 0, shedNotified: false, dup: new Map() }; state.set(deviceId, s); }

  // Roll the fixed rate window.
  if (now - s.winStart >= config.contentAckRateWindowMs) {
    s.winStart = now;
    s.count = 0;
    s.shedNotified = false;
    // Bound the dedup map: drop entries older than the dedup window.
    for (const [k, t] of s.dup) if (now - t >= config.contentAckDedupMs) s.dup.delete(k);
  }

  // 1) Dedup — exact (content, status) repeat within the dedup window. Does NOT
  //    consume rate budget (it's a legit repeat we simply suppress).
  const key = `${contentId}|${status}`;
  if (now - (s.dup.get(key) || 0) < config.contentAckDedupMs) return { action: 'dedup' };
  s.dup.set(key, now);

  // 2) Per-device rate budget — always applies, counts all non-duplicate acks.
  s.count++;
  if (s.count > config.contentAckMaxPerWindow) {
    const logStart = !s.shedNotified; // log ONCE per device per window when shedding starts
    s.shedNotified = true;
    return { action: 'shed-rate', logStart, observed: s.count, budget: config.contentAckMaxPerWindow };
  }

  // 3) Global valve — extra shedding only under critical lag; a within-budget device
  //    in a non-critical band is never touched here.
  if (band === 'critical') return { action: 'shed-valve' };

  return { action: 'pass' };
}

// #146 Item E: evict idle per-device buckets so this Map can't grow unbounded over
// churned device_ids (a SNAT flood minting provisioning ids inflated every un-swept
// per-device Map). Keyed by winStart age.
function sweep(now = Date.now()) {
  let n = 0;
  const idle = config.contentAckRateWindowMs * 4;
  for (const [k, s] of state) if (now - s.winStart > idle) { state.delete(k); n++; }
  return n;
}
let sweepTimer = null;
function startSweep() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => sweep(), config.contentAckRateWindowMs * 4);
  if (sweepTimer.unref) sweepTimer.unref();
  return sweepTimer;
}

function reset() { state.clear(); } // tests
module.exports = { check, reset, sweep, startSweep, _size: () => state.size };
