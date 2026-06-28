// #142 step 3 — load-aware per-device reconnect throttle (the outage fix).
//
// A single device stuck in a tight websocket reconnect loop can flood the server
// with full register cycles (DB writes + playlist build) and saturate the event
// loop. This module gates genuine reconnects PER DEVICE, before that heavy work
// runs in deviceSocket.js.
//
// Design (mirrors the issue's suggested mitigation + the lastPlayLogAt pattern):
//   - WHO is always per-device: a device is "flagged" only when it exceeds
//     reconnectBaseMax genuine reconnects within reconnectWindowMs. Global lag
//     NEVER flags a healthy device.
//   - Load-awareness is BANDED (normal/elevated/critical from services/loop-lag),
//     not a continuous controller — deterministic and testable. The band only
//     MULTIPLIES the backoff applied to an ALREADY-flagged device.
//   - Hysteresis: escalate immediately while storming (tighten fast); decay the
//     escalation level one step per reconnectReleaseMs of calm (release slow).
//   - HARD CEILING: independent of band and of warm-up, no device may exceed
//     reconnectHardCeiling/window — a slow-ramp attacker can't train through it.
//   - COLD START: for reconnectWarmupMs after process start, force the 'normal'
//     band and apply only the hard ceiling, so a full-fleet reconnect right after
//     a deploy doesn't throttle healthy screens.
//   - State is in-memory (resets on restart), like pair-lockout / totp-lockout.

const config = require('../config');
const loopLag = require('../services/loop-lag');

// deviceId -> { hits: number[], level: number, blockedUntil: ms, lastThrottleAt: ms }
const state = new Map();
let startedAt = Date.now();

function bandMultiplier(band) {
  if (band === 'critical') return config.reconnectBandCriticalMult;
  if (band === 'elevated') return config.reconnectBandElevatedMult;
  return 1;
}

function reject(s, now, band, reason, observed, allowed) {
  s.level = Math.min(s.level + 1, config.reconnectMaxLevel);
  const backoff = Math.min(
    config.reconnectBaseBackoffMs * Math.pow(2, s.level - 1) * bandMultiplier(band),
    config.reconnectMaxBackoffMs
  );
  s.blockedUntil = now + backoff;
  s.lastThrottleAt = now;
  return { allow: false, retryAfterMs: backoff, reason, observed, allowed, band, level: s.level };
}

// Decide whether to allow a genuine reconnect for `deviceId`.
// `now` and `bandOverride` are injectable for deterministic tests; production
// passes only deviceId.
function check(deviceId, now = Date.now(), bandOverride = null) {
  const warmup = (now - startedAt) < config.reconnectWarmupMs;
  const band = bandOverride !== null ? bandOverride : (warmup ? 'normal' : loopLag.getBand());

  let s = state.get(deviceId);
  if (!s) { s = { hits: [], level: 0, blockedUntil: 0, lastThrottleAt: 0 }; state.set(deviceId, s); }

  // Already inside an enforced backoff window: reject and escalate (tighten fast).
  if (now < s.blockedUntil) {
    return reject(s, now, band, 'in-backoff', s.hits.length, config.reconnectBaseMax);
  }

  // Sliding window of genuine reconnects.
  s.hits = s.hits.filter((t) => now - t < config.reconnectWindowMs);
  s.hits.push(now);
  const observed = s.hits.length;

  // Hard ceiling — always enforced, regardless of band or warm-up.
  if (observed > config.reconnectHardCeiling) {
    return reject(s, now, band, 'hard-ceiling', observed, config.reconnectHardCeiling);
  }

  // Cold start: only the hard ceiling applies; never rate-throttle during warm-up.
  if (warmup) return allow(s, now, band);

  // Healthy device: under the per-device threshold -> always allowed.
  if (observed <= config.reconnectBaseMax) return allow(s, now, band);

  // Flagged: storming beyond the per-device threshold -> throttle (band-scaled).
  return reject(s, now, band, 'rate', observed, config.reconnectBaseMax);
}

function allow(s, now, band) {
  // Release slow: decay one escalation level per reconnectReleaseMs of calm.
  if (s.level > 0 && now - s.lastThrottleAt > config.reconnectReleaseMs) {
    s.level = Math.max(0, s.level - 1);
    s.lastThrottleAt = now;
  }
  return { allow: true, band, level: s.level };
}

// Test-only: clear state and optionally rewind the warm-up origin.
function __resetForTest(opts = {}) {
  state.clear();
  if (opts.startedAt !== undefined) startedAt = opts.startedAt;
}

module.exports = { check, __resetForTest };
