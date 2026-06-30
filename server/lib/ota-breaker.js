// #144 — OTA update-check circuit-breaker + phantom-version guard.
//
// The /api/update/check handler offered the update whenever client !== latest (raw
// string inequality, not semver). A device that can't APPLY the update (old/broken
// OTA client like 1.7.12, signing mismatch, Fire OS) keeps reporting the same old
// version and is told update_available=true on every poll. A fast poll loop (10-30s)
// then saturates the event loop (prod loop-lag 49s).
//
// Two independent axes (kept separate on purpose):
//
//  1. RATE breaker (primary, immediate). Healthy devices poll ~every 12 min, so a key
//     checking MORE than THRESHOLD times within WINDOW (default >3 / 60s) is by
//     definition looping -> throttle update_available for that key with exponential
//     backoff. Catches the fast flood within seconds. A normally-polling device never
//     approaches this rate, so rollout/straggler updates are inherently safe — there
//     is deliberately NO "tolerate the flood for N minutes" grace; slow == safe.
//
//  2. PHANTOM guard (immediate). An unrecognized version, or a prerelease of an OLDER
//     core (a superseded old-minor beta — e.g. 1.9.1-beta4 when latest is 1.9.2-beta3),
//     gets "no offer" on the first check. A RECENT real older version (e.g. beta3 when
//     latest is beta4, or stable 1.7.12) is legitimately offerable and is NOT phantom.
//
// KEYING: keyed on device_id when the client sends one (beta4+ clients -> precise
// per-device throttling), falling back to the reported VERSION when absent (legacy
// clients send only ?version=, and the site is behind NAT so IP is useless). So every
// device is covered: new clients per-device, stuck legacy clients per-version.
//
// Constants are env-tunable for ops + tests.

const WINDOW_MS = parseInt(process.env.OTA_BREAKER_WINDOW_MS) || 60_000;   // rate window
const THRESHOLD = parseInt(process.env.OTA_BREAKER_THRESHOLD) || 3;        // checks/window before tripping (>THRESHOLD trips)
const COOLDOWNS_MS = (process.env.OTA_BREAKER_COOLDOWNS_MS
  ? process.env.OTA_BREAKER_COOLDOWNS_MS.split(',').map(s => parseInt(s, 10))
  : [30_000, 120_000, 480_000, 1_800_000]);                               // 30s -> 2m -> 8m -> cap 30m
const IDLE_RESET_MS = parseInt(process.env.OTA_BREAKER_IDLE_RESET_MS) || 60 * 60 * 1000;

const state = new Map();          // key -> { hits:number[], blockedUntil, level, lastSeen }
const loggedBad = new Set();      // log unrecognized/superseded versions once

// --- minimal semver-ish parse/compare (no dependency) ---
function parseVer(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v.trim());
  if (!m) return null;
  return { core: [+m[1], +m[2], +m[3]], pre: m[4] || null };
}
function coreCmp(a, b) { for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1; return 0; }
function cmpParsed(a, b) {
  const c = coreCmp(a, b);
  if (c !== 0) return c;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;     // release outranks a prerelease of the same core
  if (b.pre === null) return -1;
  // lexical prerelease compare — fine for beta1..beta9 (cores decide everything else).
  return a.pre < b.pre ? -1 : (a.pre > b.pre ? 1 : 0);
}
function cmp(a, b) { const pa = parseVer(a), pb = parseVer(b); return (!pa || !pb) ? null : cmpParsed(pa, pb); }

// decide(clientVersion, latestVersion, deviceId?, now?) ->
//   { update_available, reason, retry_after_seconds?, log? }
function decide(clientVersion, latestVersion, deviceId = null, now = Date.now()) {
  // ---- PHANTOM / unrecognized guard (immediate, version-based, no rate state) ----
  if (!clientVersion) return { update_available: false, reason: 'no-version' };
  const pc = parseVer(clientVersion), pl = parseVer(latestVersion);
  if (!pc || !pl) return { update_available: false, reason: 'unrecognized-version', log: logOnce(clientVersion, `[ota] unrecognized client version '${clientVersion}' — no offer (latest=${latestVersion})`) };
  const full = cmpParsed(pc, pl);
  if (full === 0) return { update_available: false, reason: 'up-to-date' };
  if (full > 0) return { update_available: false, reason: 'client-newer' };       // never offer a downgrade
  if (pc.pre !== null && coreCmp(pc, pl) < 0) {                                    // superseded old-core prerelease (e.g. 1.9.1-beta4)
    return { update_available: false, reason: 'superseded-prerelease', log: logOnce(clientVersion, `[ota] superseded prerelease '${clientVersion}' (older core than latest=${latestVersion}) — no offer`) };
  }

  // ---- offerable (recent real older version) -> RATE breaker, keyed per device / per version ----
  const key = deviceId ? 'd:' + deviceId : 'v:' + clientVersion;
  let b = state.get(key);
  if (!b) { b = { hits: [], blockedUntil: 0, level: 0, lastSeen: now }; state.set(key, b); }
  if (now - b.lastSeen > IDLE_RESET_MS) { b.hits = []; b.blockedUntil = 0; b.level = 0; } // long-quiet -> fresh
  b.lastSeen = now;

  if (now < b.blockedUntil) {
    return { update_available: false, reason: 'rate-backoff', retry_after_seconds: Math.ceil((b.blockedUntil - now) / 1000) };
  }
  if (b.blockedUntil !== 0) b.blockedUntil = 0;   // cooldown elapsed -> probe window

  b.hits = b.hits.filter(t => now - t < WINDOW_MS);
  b.hits.push(now);
  if (b.hits.length > THRESHOLD) {                 // looping faster than a healthy device ever would
    const cd = COOLDOWNS_MS[Math.min(b.level, COOLDOWNS_MS.length - 1)];
    b.blockedUntil = now + cd;
    // #146 cosmetic: cap the level counter so the log doesn't read "level 32". The
    // backoff is already capped (Math.min above); the counter just shouldn't run away
    // past the point where it stops affecting the cooldown.
    b.level = Math.min(b.level + 1, COOLDOWNS_MS.length);
    b.hits = [];                                   // require a fresh burst to re-trip after cooldown
    return { update_available: false, reason: 'rate-backoff', retry_after_seconds: Math.ceil(cd / 1000),
             log: `[ota] breaker tripped key=${key} (>${THRESHOLD} checks/${Math.round(WINDOW_MS / 1000)}s, looping) -> backoff ${Math.round(cd / 1000)}s [level ${b.level}]` };
  }
  return { update_available: true, reason: 'offer' };
}

function logOnce(version, msg) { if (loggedBad.has(version)) return undefined; loggedBad.add(version); return msg; }

// #144: actively EVICT idle buckets so the keyed state can't grow unbounded over time
// (churned device_ids, varied versions). reset-on-access alone never deletes; this does.
function sweep(now = Date.now()) {
  let n = 0;
  for (const [k, b] of state) if (now - b.lastSeen > IDLE_RESET_MS) { state.delete(k); n++; }
  if (n > 0) console.log(`[ota] breaker swept ${n} idle bucket(s) (idle > ${Math.round(IDLE_RESET_MS / 60000)}m); ${state.size} remain`);
  return n;
}
let sweepTimer = null;
function startSweep() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => sweep(), IDLE_RESET_MS);
  if (sweepTimer.unref) sweepTimer.unref();   // don't keep the process alive on this timer
  return sweepTimer;
}

function reset() { state.clear(); loggedBad.clear(); }
function _size() { return state.size; }
module.exports = { decide, reset, sweep, startSweep, cmp, parseVer, _size, WINDOW_MS, THRESHOLD };
