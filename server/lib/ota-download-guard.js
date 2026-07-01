'use strict';
// #146 Item C — GLOBAL admission control for /download/apk. NOT per-IP: the fleet SNATs
// to one IP, so per-IP would collapse the fleet into one bucket. Concurrency + rate caps
// + critical-band shed protect the loop and IO from a download flood; a per-window
// aggregate makes the flood visible. Pure + testable; mutates the passed rolling state.

const config = require('../config');

// newState() — the single bounded rolling counter the endpoint keeps.
function newState() { return { inFlight: 0, windowStart: 0, windowCount: 0, served: 0, shed: 0 }; }

// admit(state, band, now) -> { allow, status?, retryAfter?, summary? }
//   summary (when a window just rolled) = { served, shed } to log, else null.
// NEVER takes an IP — admission is global by construction.
//
// #146 P1.2: caps are BAND-AWARE — a LOAD-TIME backstop, not a healthy-state limiter.
//   - normal   : serve FREELY (no concurrency/rate cap) so a coordinated rollout of the
//                whole fleet isn't staggered while the server is perfectly healthy.
//   - elevated : the configured concurrency/rate caps engage (early backpressure).
//   - critical : shed (503) — the real protection.
// Kill switch: OTA_DOWNLOAD_GUARD_ENABLED=false disables everything (always allow).
function admit(state, band, now = Date.now()) {
  let summary = null;
  if (now - state.windowStart >= config.otaDownloadWindowMs) {
    if (state.served || state.shed) summary = { served: state.served, shed: state.shed, inFlight: state.inFlight };
    state.windowStart = now; state.windowCount = 0; state.served = 0; state.shed = 0;
  }

  if (config.otaDownloadGuardEnabled) {
    if (band === 'critical') { state.shed++; return { allow: false, status: 503, retryAfter: 30, summary }; }
    if (band === 'elevated') {
      const overGlobal = state.inFlight >= config.otaDownloadMaxConcurrent || state.windowCount >= config.otaDownloadMaxPerWindow;
      if (overGlobal) { state.shed++; return { allow: false, status: 503, retryAfter: 10, summary }; }
    }
    // band === 'normal': no cap — serve freely.
  }

  state.inFlight++; state.windowCount++; state.served++;
  return { allow: true, summary };
}

// release() — call when a served response finishes/closes (once).
function release(state) { state.inFlight = Math.max(0, state.inFlight - 1); }

module.exports = { newState, admit, release };
