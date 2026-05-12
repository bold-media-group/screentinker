const { db } = require('../db/database');
const proxyaddr = require('proxy-addr');
const { trustedProxies } = require('../config/cloudflareIps');

// Gate function: returns true when an immediate TCP peer is one we trust
// to populate forwarding headers (Cloudflare edges, loopback, link-local,
// unique-local). Mirrors what `app.set('trust proxy', trustedProxies)` does
// for X-Forwarded-For so that CF-Connecting-IP is held to the same standard.
const isTrustedPeer = proxyaddr.compile(trustedProxies);

// Resolve the real client IP for logging.
//
// Cloudflare always sets `CF-Connecting-IP` to the original client address
// when it proxies a request. We prefer that header — but only when the
// connection's immediate peer is a trusted CF/loopback address; otherwise
// any random visitor could spoof the header by hitting the origin directly.
//
// Falls back to req.ip (which Express resolves via the trust-proxy table)
// so local dev and any non-CF deployment keep working unchanged.
function getClientIp(req) {
  if (!req) return null;
  const cf = req.headers && req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length > 0) {
    const peer = req.socket && req.socket.remoteAddress;
    if (peer && isTrustedPeer(peer, 0)) return cf;
  }
  return req.ip || null;
}

// Phase 2.2 writer-leak fix: activity_log rows now stamp workspace_id so
// tenant-scoped queries don't miss new events. Callers pass the workspace
// when known; the middleware below sources it from resolveTenancy. When
// workspaceId is null but a device_id is provided, fall back to the device's
// workspace - matches the backfill rule for consistency.
function logActivity(userId, action, details = null, deviceId = null, ipAddress = null, workspaceId = null) {
  try {
    let ws = workspaceId || null;
    if (!ws && deviceId) {
      const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
      ws = d?.workspace_id || null;
    }
    db.prepare(
      'INSERT INTO activity_log (user_id, device_id, action, details, ip_address, workspace_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId || null, deviceId || null, action, details || null, ipAddress || null, ws);
  } catch (e) {
    console.error('Activity log error:', e.message);
  }
}

function getActivity(options = {}) {
  const { userId, deviceId, limit = 50, offset = 0 } = options;
  let sql = `SELECT al.*, u.name as user_name, u.email as user_email
    FROM activity_log al LEFT JOIN users u ON al.user_id = u.id WHERE 1=1`;
  const params = [];

  if (userId) { sql += ' AND al.user_id = ?'; params.push(userId); }
  if (deviceId) { sql += ' AND al.device_id = ?'; params.push(deviceId); }

  sql += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

// Prune old activity logs (keep 90 days)
function pruneActivityLog() {
  db.prepare("DELETE FROM activity_log WHERE created_at < strftime('%s','now') - (90 * 86400)").run();
}

// Express middleware to auto-log API mutations
function activityLogger(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    // Only log successful mutations
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && res.statusCode < 400) {
      const action = `${req.method} ${req.baseUrl || ''}${req.route?.path || req.path}`;
      const userId = req.user?.id;
      const deviceId = req.params?.id || req.params?.deviceId || req.body?.device_id;
      const details = summarizeAction(req);
      logActivity(userId, action, details, deviceId, getClientIp(req), req.workspaceId || null);
    }
    return originalJson(data);
  };
  next();
}

function summarizeAction(req) {
  const parts = [];
  if (req.body?.name) parts.push(`name: ${req.body.name}`);
  if (req.body?.filename) parts.push(`file: ${req.body.filename}`);
  if (req.body?.pairing_code) parts.push('device paired');
  if (req.body?.plan_id) parts.push(`plan: ${req.body.plan_id}`);
  if (req.file?.originalname) parts.push(`uploaded: ${req.file.originalname}`);
  return parts.join(', ') || null;
}

module.exports = { logActivity, getActivity, pruneActivityLog, activityLogger, getClientIp };
