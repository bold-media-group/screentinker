// #142 — Event-loop lag telemetry (the data subsystem; ships before the throttle).
//
// Continuously samples event-loop delay via perf_hooks.monitorEventLoopDelay()
// (a C++-backed histogram — cheap). Each window we read mean/p50/p99/max, persist
// a row to the bounded `event_loop_lag` table, and recompute a coarse load BAND
// (normal | elevated | critical) from the window p99.
//
// The band is consumed by the reconnect throttle (#142 step 3), but this module
// has standalone value: getLag() is surfaced on /api/status and band changes are
// logged, so site connectivity/lag is diagnosable independent of any throttling.
//
// Band transitions are deliberately asymmetric (see nextBand): jump UP immediately
// when an up-threshold is crossed (tighten fast), step DOWN only one level at a
// time after lagReleaseSamples consecutive calm samples below a deadband (release
// slow). This avoids band flap from transient blips.

const { monitorEventLoopDelay } = require('perf_hooks');
const { db } = require('../db/database');
const config = require('../config');

const NS_PER_MS = 1e6;
// A band releases only once p99 falls below this fraction of the band's entry
// threshold — the deadband that stops small fluctuations from flapping the band.
const DEADBAND = 0.5;
const LEVEL = { normal: 0, elevated: 1, critical: 2 };

let histogram = null;
let band = 'normal';
let calmSamples = 0;
let current = { mean_ms: 0, p50_ms: 0, p99_ms: 0, max_ms: 0, band: 'normal', sampled_at: 0 };

// Pure band-transition function (exported for deterministic unit tests). Given the
// current band, the window p99 (ms), and the running calm-sample count, returns the
// next [band, calmSamples]. Up is immediate (may skip a level); down is one step
// per release window, gated by a deadband.
function nextBand(cur, p99, calm) {
  const level = LEVEL[cur] ?? 0;
  // UP — immediate, tighten fast (normal can jump straight to critical).
  if (p99 >= config.lagCriticalMs && level < LEVEL.critical) return ['critical', 0];
  if (p99 >= config.lagElevatedMs && level < LEVEL.elevated) return ['elevated', 0];
  // DOWN — slow, one step, only below the current band's deadband.
  if (level === LEVEL.critical && p99 <= config.lagCriticalMs * DEADBAND) {
    const c = calm + 1;
    return c >= config.lagReleaseSamples ? ['elevated', 0] : ['critical', c];
  }
  if (level === LEVEL.elevated && p99 <= config.lagElevatedMs * DEADBAND) {
    const c = calm + 1;
    return c >= config.lagReleaseSamples ? ['normal', 0] : ['elevated', c];
  }
  // Hold (inside deadband, or already normal): reset the calm counter.
  return [cur, 0];
}

const round2 = (x) => Math.round(x * 100) / 100;

function sample() {
  const p99 = histogram.percentile(99) / NS_PER_MS;
  const snap = {
    mean_ms: round2(histogram.mean / NS_PER_MS),
    p50_ms: round2(histogram.percentile(50) / NS_PER_MS),
    p99_ms: round2(p99),
    max_ms: round2(histogram.max / NS_PER_MS),
  };
  histogram.reset();

  const prev = band;
  [band, calmSamples] = nextBand(band, snap.p99_ms, calmSamples);
  current = { ...snap, band, sampled_at: Math.floor(Date.now() / 1000) };

  try {
    db.prepare(
      'INSERT INTO event_loop_lag (sampled_at, mean_ms, p50_ms, p99_ms, max_ms, band) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(current.sampled_at, snap.mean_ms, snap.p50_ms, snap.p99_ms, snap.max_ms, band);
  } catch (_) { /* table may not exist on a partially-migrated DB */ }

  // Observable: log whenever we're loaded or when the band changes (incl. back to
  // normal). Healthy steady state stays quiet.
  if (band !== 'normal' || prev !== 'normal') {
    const tag = band !== prev ? ` (was ${prev})` : '';
    console.log(`[loop-lag] band=${band}${tag} mean=${snap.mean_ms}ms p99=${snap.p99_ms}ms max=${snap.max_ms}ms`);
  }

  // #143 global pressure valve — log ONLY the band edge (open/close), not per shed
  // message. When critical, deviceSocket sheds non-essential acks (it reads getBand()).
  if (band === 'critical' && prev !== 'critical') {
    console.warn(`[shed] global valve OPEN — loop-lag critical (p99=${snap.p99_ms}ms); shedding non-essential device messages (content-acks). reconnects + dashboard still processed.`);
  } else if (prev === 'critical' && band !== 'critical') {
    console.log(`[shed] global valve CLOSED — loop-lag recovered (band=${band}, p99=${snap.p99_ms}ms)`);
  }
}

function pruneLag() {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - Math.round(config.lagTelemetryRetentionDays * 86400);
    const n = db.prepare('DELETE FROM event_loop_lag WHERE sampled_at < ?').run(cutoff).changes;
    if (n > 0) console.log(`[loop-lag] pruned ${n} sample(s) older than ${config.lagTelemetryRetentionDays}d`);
  } catch (_) { /* ignore */ }
}

function startLoopLagMonitor() {
  if (histogram) return; // idempotent
  histogram = monitorEventLoopDelay({ resolution: config.lagResolutionMs });
  histogram.enable();
  const t1 = setInterval(sample, config.lagSampleIntervalMs);
  pruneLag(); // sweep stale rows on boot
  const t2 = setInterval(pruneLag, config.lagPruneIntervalMs);
  // Don't keep the process alive on these timers (matters for tests / clean exit).
  if (t1.unref) t1.unref();
  if (t2.unref) t2.unref();
}

function getBand() { return band; }
function getLag() { return { ...current }; }

module.exports = { startLoopLagMonitor, getBand, getLag, nextBand };
