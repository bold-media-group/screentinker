'use strict';
// #146 hardening — bounded, yielding maintenance so NO sweep blocks the event loop.
//
// The #146 death spiral's amplifier was pruneStatusLog running a whole-table
// ROW_NUMBER() sort — 40-48s synchronous on a 1.1M-row table, freezing boot into a
// restart loop. This helper is the discipline every table-growth sweep now rides:
//   - delete in bounded batches (config.statusLogPruneBatch rows max per statement),
//   - `await setImmediate` between batches so the loop breathes (core invariant: no
//     sync op blocks >~50ms, ever, regardless of table size),
//   - optional band-gate: skip an INTERVAL run entirely when loop-lag is not normal
//     (never add maintenance pressure while already loaded); startup runs un-gated so
//     it can clear an existing backlog and self-heal without a restart.
//
// better-sqlite3's bundled SQLite is NOT built with SQLITE_ENABLE_UPDATE_DELETE_LIMIT,
// so `DELETE ... LIMIT` is a syntax error. We delete by `rowid IN (SELECT rowid ...
// LIMIT ?)`, which is portable and rides whatever index the inner SELECT uses.

const config = require('../config');

const yieldTick = () => new Promise((resolve) => setImmediate(resolve));

// Lazy + defensive band read — avoids a load-time cycle (loop-lag requires db, db's
// prune requires this). Returns 'normal' if the monitor isn't wired yet (e.g. tests).
let _getBand = null;
function currentBand() {
  if (_getBand === null) {
    try { _getBand = require('../services/loop-lag').getBand; } catch { _getBand = () => 'normal'; }
  }
  try { return _getBand(); } catch { return 'normal'; }
}

// Run `runBatch(limit)` (a synchronous DELETE returning rows-deleted) to completion in
// bounded batches, yielding between each. Stops when a batch deletes < limit (drained).
// Returns { skipped, deleted, batches }.
async function chunkedDelete(runBatch, opts = {}) {
  const batch = opts.batch || config.statusLogPruneBatch;
  if (opts.bandGate && currentBand() !== 'normal') return { skipped: true, deleted: 0, batches: 0 };
  let total = 0, batches = 0, n;
  do {
    n = runBatch(batch);
    total += n;
    batches += 1;
    if (n > 0) await yieldTick();
  } while (n >= batch);   // a short (or zero) batch means the predicate is drained
  return { skipped: false, deleted: total, batches };
}

module.exports = { chunkedDelete, yieldTick, currentBand, __setBandForTest: (fn) => { _getBand = fn; } };
