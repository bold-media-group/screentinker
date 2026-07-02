'use strict';
// #146 Item E — coalescing log buffer. Under a storm, high-frequency lines (loop-lag
// band, per-request OTA checks, repetitive "Device reconnected") turn console.log —
// which is a SYNCHRONOUS stdout write — into its own event-loop hog. This dedups by key
// + counts, flushing ONE summarized line per key per interval:
//   `[loop-lag] band=critical (x47 in 30s)`
// Trading a little bounded RAM for loop safety is explicitly desired. The buffer is
// BOUNDED (MAX_KEYS): if it fills, we flush immediately rather than grow.

const MAX_KEYS = 500;

// key -> { count, sample (the latest full line), warn }
const buf = new Map();
let flushMs = 30000;
let timer = null;

// record(key, line, {warn, peak, peakUnit}) — `key` collapses repeats; `line` is the
// stable human text. #146 P3.7: `peak` (a number) tracks the MAX over the window so the
// summary carries the PEAK (the number that matters in an incident), not an arbitrary
// sample's value.
function record(key, line, opts = {}) {
  let e = buf.get(key);
  if (!e) {
    if (buf.size >= MAX_KEYS) flush();           // bounded: never grow past MAX_KEYS
    e = { count: 0, sample: line, warn: !!opts.warn, peak: null, peakUnit: opts.peakUnit || '' };
    buf.set(key, e);
  }
  e.count += 1;
  e.sample = line;                                // keep the most recent stable label
  e.warn = e.warn || !!opts.warn;
  if (opts.peak != null) { e.peak = e.peak == null ? opts.peak : Math.max(e.peak, opts.peak); if (opts.peakUnit) e.peakUnit = opts.peakUnit; }
}

function flush() {
  for (const [, e] of buf) {
    let line;
    if (e.count > 1) {
      const peak = e.peak != null ? `, peak ${e.peak}${e.peakUnit}` : '';
      line = `${e.sample} (x${e.count} in ${Math.round(flushMs / 1000)}s${peak})`;
    } else {
      line = e.peak != null ? `${e.sample} (${e.peak}${e.peakUnit})` : e.sample;
    }
    (e.warn ? console.warn : console.log)(line);
  }
  buf.clear();
}

function start(ms) {
  if (ms) flushMs = ms;
  if (!timer) { timer = setInterval(flush, flushMs); if (timer.unref) timer.unref(); }
}

function reset() { buf.clear(); }                 // tests
module.exports = { record, flush, start, reset, _size: () => buf.size };
