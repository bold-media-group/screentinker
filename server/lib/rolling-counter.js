'use strict';
// #146 observability — a scalar THROUGHPUT counter with a fixed rolling window. Bounded
// (four ints, no per-key map, no timer): the window rolls lazily on bump AND on read, so
// an idle subsystem's `lastWindow` correctly decays to the last COMPLETED window (or 0 if
// two+ windows passed with no activity) without a background timer. Shared so the roll
// logic is identical everywhere.

const config = require('../config');

function rollingCounter(windowMs = config.debugStatsWindowMs) {
  return { total: 0, curWindow: 0, lastWindow: 0, windowStart: 0, windowMs };
}

// Roll if the current window has elapsed. First touch just anchors windowStart.
function roll(c, now) {
  if (c.windowStart === 0) { c.windowStart = now; return; }
  const elapsed = now - c.windowStart;
  if (elapsed >= c.windowMs) {
    // exactly one window closed -> lastWindow is what accumulated; 2+ -> last completed was empty
    c.lastWindow = elapsed < 2 * c.windowMs ? c.curWindow : 0;
    c.curWindow = 0;
    c.windowStart = now;
  }
}

function bump(c, now = Date.now(), n = 1) { roll(c, now); c.curWindow += n; c.total += n; }

// Plain, cheap read: { total, lastWindow } (rolls first so idle reads are accurate).
function read(c, now = Date.now()) { roll(c, now); return { total: c.total, lastWindow: c.lastWindow }; }

module.exports = { rollingCounter, bump, read };
