// Public (unauthenticated) error sink for the player. Smart TVs and other
// embedded browsers without devtools POST their captured error logs here so
// we have visibility into client-side problems we'd otherwise never see.
//
// Submitter is unauthenticated by design - the player may not have paired
// yet when an error fires. Rate-limited 10 req/min per IP+path via
// app.use('/api/player-debug', rateLimit(60000, 10)) in server.js.
//
// IP is captured from req.ip, which respects X-Forwarded-For thanks to
// app.set('trust proxy', trustedProxies) in server.js - so on prod we
// get the real client IP, not the Cloudflare edge IP.

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');

// Hard caps on string lengths so an unauth caller can't fill the DB with a
// single 10MB request. The client itself only sends bounded data, but we
// don't trust that on a public endpoint.
const MAX_DEVICE_ID = 64;
const MAX_UA = 500;
const MAX_URL = 2000;
const MAX_FP = 64;
const MAX_ERROR_DATA = 50000; // ~50KB of JSON. Generous but bounded.
const MAX_CONTEXT = 20000;    // ~20KB.
const ROW_CAP = 10000;
const PRUNE_BATCH = 100;

function clamp(s, max) {
  if (s == null) return null;
  return String(s).slice(0, max);
}

function clampJson(obj, max) {
  if (obj == null) return null;
  try {
    let s = JSON.stringify(obj);
    if (s.length > max) s = s.slice(0, max);
    return s;
  } catch (e) {
    return null;
  }
}

const insertStmt = db.prepare(`
  INSERT INTO player_debug_logs
    (device_id, ip, user_agent, url, error_fingerprint, error_data, context)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const countStmt = db.prepare('SELECT COUNT(*) AS n FROM player_debug_logs');
const pruneStmt = db.prepare(`
  DELETE FROM player_debug_logs
  WHERE id IN (SELECT id FROM player_debug_logs ORDER BY id ASC LIMIT ?)
`);

router.post('/', (req, res) => {
  try {
    const body = req.body || {};
    const deviceId = clamp(body.deviceId, MAX_DEVICE_ID);
    const userAgent = clamp(body.userAgent, MAX_UA);
    const url = clamp(body.url, MAX_URL);
    const fingerprint = clamp(body.error_fingerprint, MAX_FP);
    const errors = clampJson(body.errors, MAX_ERROR_DATA);
    const context = clampJson(body.context, MAX_CONTEXT);

    insertStmt.run(deviceId, req.ip, userAgent, url, fingerprint, errors, context);

    // FIFO cap. Prune the oldest PRUNE_BATCH rows when we cross ROW_CAP.
    // Done synchronously on insert so the cap is never far exceeded; cost is
    // bounded (the DELETE is indexed via the autoinc id) and fires only
    // every PRUNE_BATCH inserts past the cap.
    const { n } = countStmt.get();
    if (n > ROW_CAP) {
      pruneStmt.run(PRUNE_BATCH);
    }

    res.status(204).end();
  } catch (e) {
    console.error('[player-debug] insert failed:', e.message);
    res.status(500).json({ error: 'insert failed' });
  }
});

// ============================================================================
// Admin routes (platform-admin only). Live under the same path prefix as the
// public POST above (/api/player-debug) but on different verb+path. The
// rate-limit middleware applied at mount-time uses req.path as part of its
// bucket key, so admin GETs don't share a quota with the public POST.
// ============================================================================

// GET /list - paginated listing, newest first, with filters.
//   query: page (1-indexed), limit (default 50, max 200),
//          ua_contains, since (unix-sec), until (unix-sec), has_error (1/0)
router.get('/list', requireAuth, requireSuperAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  const uaFilter = String(req.query.ua_contains || '').slice(0, 100);
  const since = parseInt(req.query.since) || 0;
  const until = parseInt(req.query.until) || 0;
  const hasError = req.query.has_error === '1';

  const where = [];
  const params = [];
  if (uaFilter) { where.push('user_agent LIKE ?'); params.push('%' + uaFilter + '%'); }
  if (since) { where.push('created_at >= ?'); params.push(since); }
  if (until) { where.push('created_at <= ?'); params.push(until); }
  if (hasError) {
    where.push("error_data IS NOT NULL AND error_data != '' AND error_data != '[]'");
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM player_debug_logs ${whereSql}`).get(...params).n;
  const rows = db.prepare(`
    SELECT id, device_id, ip, user_agent, url, error_fingerprint, error_data, context, created_at
    FROM player_debug_logs ${whereSql}
    ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ total, page, limit, rows });
});

// GET /summary - UA family counts for the top-of-page header summary.
// Classification order matters: smart-TV markers checked before Chrome
// (Tizen 5+ / WebOS / etc. contain Chrome/N in their UA), Edge before
// Chrome (Edg/N appears alongside Chrome/N in Chromium-Edge).
router.get('/summary', requireAuth, requireSuperAdmin, (req, res) => {
  const rows = db.prepare('SELECT user_agent FROM player_debug_logs').all();
  const counts = {
    tizen: 0, webos: 0, fire_tv: 0, bravia: 0,
    edge: 0, chrome: 0, firefox: 0, safari: 0,
    other: 0
  };
  for (const r of rows) {
    const ua = r.user_agent || '';
    if (/Tizen/i.test(ua)) counts.tizen++;
    else if (/WebOS/i.test(ua)) counts.webos++;
    else if (/AFTS|AFTT|AFTM/i.test(ua)) counts.fire_tv++;
    else if (/BRAVIA/i.test(ua)) counts.bravia++;
    else if (/Edg\/|Edge\//.test(ua)) counts.edge++;
    else if (/Chrome\//.test(ua)) counts.chrome++;
    else if (/Firefox\//.test(ua)) counts.firefox++;
    else if (/Safari\//.test(ua)) counts.safari++;
    else counts.other++;
  }
  res.json({ total: rows.length, byFamily: counts });
});

// DELETE /older-than?days=30 - manual purge. Confirmation happens client-side;
// this is a single-shot DELETE that returns the row count actually deleted.
// Bounded at 1..3650 days so a typo can't no-op or run forever.
router.delete('/older-than', requireAuth, requireSuperAdmin, (req, res) => {
  const days = Math.max(1, Math.min(3650, parseInt(req.query.days) || 30));
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const result = db.prepare('DELETE FROM player_debug_logs WHERE created_at < ?').run(cutoff);
  res.json({ deleted: result.changes, days, cutoff });
});

module.exports = router;
