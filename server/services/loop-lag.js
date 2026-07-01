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
const { chunkedDelete } = require('../lib/chunked-prune');   // #146 Item E: chunked lag prune
const logCoalescer = require('../lib/log-coalescer');        // #146 Item E: coalesced band lines

const NS_PER_MS = 1e6;
// A band releases only once p99 falls below this fraction of the band's entry
// threshold — the deadband that stops small fluctuations from flapping the band.
const DEADBAND = 0.5;
const LEVEL = { normal: 0, elevated: 1, critical: 2 };

let histogram = null;
let band = 'normal';
let calmSamples = 0;
let current = { mean_ms: 0, p50_ms: 0, p99_ms: 0, max_ms: 0, band: 'normal', sampled_at: 0 };
const lagBuffer = [];   // #146 Item E: pending telemetry rows, batch-inserted on flush

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

  // #146 Item E: BUFFER the telemetry row (batch-inserted on the flush interval) instead
  // of a synchronous INSERT per sample — under DB contention (a bloated table slowing
  // writes) a per-sample INSERT is itself a per-tick loop cost. Bounded: drop the oldest
  // if the buffer overflows (never let telemetry grow unbounded and cook the loop).
  lagBuffer.push({ ...snap, sampled_at: current.sampled_at, band });
  if (lagBuffer.length > config.lagBufferMax) lagBuffer.splice(0, lagBuffer.length - config.lagBufferMax);

  // Observable: a band CHANGE logs immediately; a repeated "still at band X" line is
  // COALESCED (one summarized line per flush) so a sustained-critical storm can't turn
  // logging into its own loop hog. Healthy steady state stays quiet.
  if (band !== prev) {
    console.log(`[loop-lag] band=${band} (was ${prev}) mean=${snap.mean_ms}ms p99=${snap.p99_ms}ms max=${snap.max_ms}ms`);
  } else if (band !== 'normal') {
    logCoalescer.record(`loop-lag:${band}`, `[loop-lag] band=${band} p99=${snap.p99_ms}ms max=${snap.max_ms}ms`);
  }

  // #143 global pressure valve — log ONLY the band edge (open/close), not per shed
  // message. When critical, deviceSocket sheds non-essential acks (it reads getBand()).
  if (band === 'critical' && prev !== 'critical') {
    console.warn(`[shed] global valve OPEN — loop-lag critical (p99=${snap.p99_ms}ms); shedding non-essential device messages (content-acks). reconnects + dashboard still processed.`);
  } else if (prev === 'critical' && band !== 'critical') {
    console.log(`[shed] global valve CLOSED — loop-lag recovered (band=${band}, p99=${snap.p99_ms}ms)`);
  }
}

// #146 Item E: flush buffered telemetry rows in ONE batched transaction.
const _insLag = db.prepare('INSERT INTO event_loop_lag (sampled_at, mean_ms, p50_ms, p99_ms, max_ms, band) VALUES (?, ?, ?, ?, ?, ?)');
function flushLag() {
  if (!lagBuffer.length) return;
  const rows = lagBuffer.splice(0);
  try {
    db.transaction((rs) => { for (const r of rs) _insLag.run(r.sampled_at, r.mean_ms, r.p50_ms, r.p99_ms, r.max_ms, r.band); })(rows);
  } catch (_) { /* table may not exist on a partially-migrated DB — drop the batch */ }
}

// #146 Item E: chunked prune (rides idx_event_loop_lag_sampled) so this table can never
// repeat the status_log bloat-then-freeze. Async; callers fire-and-forget.
const _delLag = db.prepare('DELETE FROM event_loop_lag WHERE rowid IN (SELECT rowid FROM event_loop_lag WHERE sampled_at < ? LIMIT ?)');
async function pruneLag() {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - Math.round(config.lagTelemetryRetentionDays * 86400);
    const { deleted } = await chunkedDelete((lim) => _delLag.run(cutoff, lim).changes, { batch: config.statusLogPruneBatch });
    if (deleted > 0) console.log(`[loop-lag] pruned ${deleted} sample(s) older than ${config.lagTelemetryRetentionDays}d`);
  } catch (_) { /* ignore */ }
}

function startLoopLagMonitor() {
  if (histogram) return; // idempotent
  histogram = monitorEventLoopDelay({ resolution: config.lagResolutionMs });
  histogram.enable();
  logCoalescer.start(config.logCoalesceFlushMs);           // #146 Item E: start the coalesced-log flusher
  const t1 = setInterval(sample, config.lagSampleIntervalMs);
  const t3 = setInterval(flushLag, config.lagFlushMs);      // #146 Item E: batch-insert buffered telemetry
  pruneLag().catch(() => {});                               // sweep stale rows on boot (chunked, async)
  const t2 = setInterval(() => pruneLag().catch(() => {}), config.lagPruneIntervalMs);
  // Don't keep the process alive on these timers (matters for tests / clean exit).
  for (const t of [t1, t2, t3]) if (t.unref) t.unref();
}

function getBand() { return band; }
function getLag() { return { ...current }; }

module.exports = { startLoopLagMonitor, getBand, getLag, nextBand };
