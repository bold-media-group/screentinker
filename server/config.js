const path = require('path');

// Data locations. Everything defaults to the in-repo layout, so existing installs
// (including production) are byte-for-byte unchanged when these are unset. Set
// DATA_DIR - or the individual *_PATH / *_DIR vars - to relocate state onto a
// mounted volume (used by the Docker image). UNSET resolves to exactly the legacy
// paths: server/db/remote_display.db, server/uploads/, server/certs/.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const uploadsDir = process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads');
const certsDir = process.env.CERTS_DIR || path.join(DATA_DIR, 'certs');

module.exports = {
  port: process.env.PORT || 3001,
  httpsPort: process.env.HTTPS_PORT || 3443,
  dataDir: DATA_DIR,
  dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'db', 'remote_display.db'),
  uploadsDir,
  contentDir: path.join(uploadsDir, 'content'),
  screenshotsDir: path.join(uploadsDir, 'screenshots'),
  certsDir,
  frontendDir: path.join(__dirname, '..', 'frontend'),
  // App-level heartbeat. Checker runs every heartbeatInterval and marks
  // devices offline if last_heartbeat is older than heartbeatTimeout.
  // Env override for self-hosters on slow/jittery networks (issue #3:
  // reporter found raising HEARTBEAT_TIMEOUT to 60s reduced false offlines).
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL) || 10000,
  heartbeatTimeout:  parseInt(process.env.HEARTBEAT_TIMEOUT)  || 45000,
  // How long the server holds commands/playlist-updates for a device that's
  // offline at emit time (ms). On reconnect within this window, queued events
  // are flushed in order. Past TTL they're dropped. See lib/command-queue.js.
  commandQueueTtlMs: parseInt(process.env.COMMAND_QUEUE_TTL_MS) || 30000,
  // Engine.IO transport-level ping/pong. Raised from Socket.IO defaults
  // (25000/20000) because TV WebKits (LG webOS, older Tizen) miss pongs
  // under decode load - tighter values cause spurious transport drops.
  // Worst-case dead-socket detection: pingInterval + pingTimeout = 60s.
  pingInterval: parseInt(process.env.PING_INTERVAL) || 30000,
  pingTimeout:  parseInt(process.env.PING_TIMEOUT)  || 30000,
  maxFileSize: 500 * 1024 * 1024, // 500MB
  thumbnailWidth: 320,
  screenshotQuality: 70,
  // SSL: drop your Cloudflare Origin cert + key in certs/ folder
  // or set env vars SSL_CERT and SSL_KEY to custom paths
  sslCert: process.env.SSL_CERT || path.join(certsDir, 'cert.pem'),
  sslKey: process.env.SSL_KEY || path.join(certsDir, 'key.pem'),
  // Auth
  jwtSecret: process.env.JWT_SECRET || (() => {
    const secretFile = path.join(certsDir, '.jwt_secret');
    const fs = require('fs');
    if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
    const secret = require('crypto').randomBytes(64).toString('hex');
    try { fs.mkdirSync(path.dirname(secretFile), { recursive: true }); fs.writeFileSync(secretFile, secret); } catch {}
    return secret;
  })(),
  jwtExpiry: '7d',
  // Google OAuth - set these in env or here
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  // Microsoft OAuth - set these in env or here
  microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
  microsoftTenantId: process.env.MICROSOFT_TENANT_ID || 'common',
  // Stripe (optional - for paid subscriptions)
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  // Microsoft Graph email sender (services/email.js). Required for actual
  // delivery; absent values short-circuit to a stdout fallback for local dev.
  graphTenantId: process.env.GRAPH_TENANT_ID || '',
  graphClientId: process.env.GRAPH_CLIENT_ID || '',
  graphClientSecret: process.env.GRAPH_CLIENT_SECRET || '',
  graphSenderEmail: process.env.GRAPH_SENDER_EMAIL || '',
  graphSenderName: process.env.GRAPH_SENDER_NAME || 'ScreenTinker',
  // Dev safety net: comma-separated allow-list of recipient emails. When set,
  // sends to any address NOT in the list are suppressed (logged but not posted
  // to Graph). Intended for local dev that pulls fresh prod DB copies - keeps
  // us from accidentally emailing real prod users. UNSET on prod systemd unit.
  graphDevRestrictTo: process.env.GRAPH_DEV_RESTRICT_TO || '',
  // Self-hosted mode: if true, first user gets enterprise plan and no billing
  selfHosted: process.env.SELF_HOSTED === 'true',
  // #116: opt-in UI gate. When true, hides the Subscription nav item + billing view
  // and bounces #/billing to the dashboard. Default off, so existing deployments are
  // unchanged. UI-only — /api/subscription/* stays in place (internal usage reads).
  hideBilling: process.env.HIDE_BILLING === 'true',
  // Disable public registration (OAuth auto-signup is also blocked when set).
  // First-user setup is still allowed so a fresh install can be initialized.
  disableRegistration: ['true', '1'].includes(String(process.env.DISABLE_REGISTRATION || '').toLowerCase()),
  // Redirect / -> /app instead of serving the marketing landing page.
  // For self-hosted internal deployments that don't want the public homepage.
  disableHomepage: ['true', '1'].includes(String(process.env.DISABLE_HOMEPAGE || '').toLowerCase()),
  // Issue #12: auto-create a personal org + Default workspace for self-service
  // signups (public register + OAuth). Defaults TRUE so single-tenant and the
  // hosted self-service flow are unaffected; set AUTO_CREATE_ORG_ON_SIGNUP=false
  // on MSP-style deployments where an admin/operator assigns users to existing
  // orgs after signup instead.
  autoCreateOrgOnSignup: !['false', '0'].includes(String(process.env.AUTO_CREATE_ORG_ON_SIGNUP || '').toLowerCase()),

  // #142 event-loop lag telemetry (services/loop-lag.js). perf_hooks
  // monitorEventLoopDelay is C++-backed, so continuous sampling is cheap. Each
  // window's p99 is persisted to event_loop_lag (bounded: indexed + pruned from
  // day one) and drives the banded load level the reconnect throttle reads.
  lagSampleIntervalMs: parseInt(process.env.LAG_SAMPLE_INTERVAL_MS) || 1000,
  lagResolutionMs: parseInt(process.env.LAG_RESOLUTION_MS) || 20,
  lagTelemetryRetentionDays: parseFloat(process.env.LAG_TELEMETRY_RETENTION_DAYS) || 3,
  lagPruneIntervalMs: parseInt(process.env.LAG_PRUNE_INTERVAL_MS) || 3600000,
  // Banded load levels from the window p99 (ms). Asymmetric by design: a band is
  // entered immediately when its up-threshold is crossed (tighten fast), but
  // released only one step at a time after lagReleaseSamples consecutive samples
  // fall below a deadband (release slow), so small fluctuations don't flap it.
  // Bands ONLY scale how hard an already-flagged device is throttled; a healthy
  // device is never gated by global lag.
  lagElevatedMs: parseInt(process.env.LAG_ELEVATED_MS) || 100,
  lagCriticalMs: parseInt(process.env.LAG_CRITICAL_MS) || 250,
  lagReleaseSamples: parseInt(process.env.LAG_RELEASE_SAMPLES) || 5,

  // #142 load-aware per-device reconnect throttle (lib/reconnect-throttle.js).
  // The verdict of WHO is misbehaving is ALWAYS per-device (keyed on device_id):
  // a device is flagged only when it exceeds reconnectBaseMax genuine reconnects
  // per reconnectWindowMs. Global lag never flags a healthy device — the lag band
  // only MULTIPLIES how hard an already-flagged device is backed off.
  reconnectWindowMs: parseInt(process.env.RECONNECT_WINDOW_MS) || 10000,
  reconnectBaseMax: parseInt(process.env.RECONNECT_BASE_MAX) || 5,
  // Absolute per-device ceiling, independent of band AND of warm-up: no device may
  // exceed this many reconnects/window no matter what the adaptive logic computes,
  // so a slow-ramp attacker can't train its way through.
  reconnectHardCeiling: parseInt(process.env.RECONNECT_HARD_CEILING) || 20,
  // Server-enforced backoff for a flagged device: baseBackoff * 2^(level-1) * band
  // multiplier, capped at maxBackoff. Level escalates while it keeps storming
  // (tighten fast) and decays one step per reconnectReleaseMs of calm (release slow).
  reconnectBaseBackoffMs: parseInt(process.env.RECONNECT_BASE_BACKOFF_MS) || 1000,
  reconnectMaxBackoffMs: parseInt(process.env.RECONNECT_MAX_BACKOFF_MS) || 60000,
  reconnectMaxLevel: parseInt(process.env.RECONNECT_MAX_LEVEL) || 10,
  reconnectReleaseMs: parseInt(process.env.RECONNECT_RELEASE_MS) || 30000,
  // Cold start: for this long after process start, lag is high while the whole
  // fleet reconnects at once. Treat leniently — force the 'normal' band and apply
  // only the hard ceiling (no rate-band throttle) so a deploy can't throttle
  // healthy screens. Throttle state is in-memory and resets on restart.
  reconnectWarmupMs: parseInt(process.env.RECONNECT_WARMUP_MS) || 30000,
  reconnectBandElevatedMult: parseFloat(process.env.RECONNECT_BAND_ELEVATED_MULT) || 2,
  reconnectBandCriticalMult: parseFloat(process.env.RECONNECT_BAND_CRITICAL_MULT) || 4,

  // #142 device_status_log retention. A GLOBAL scheduled sweep (pruneStatusLog in
  // db/database.js, run on startup + the heartbeat interval) deletes rows older
  // than this across ALL devices — covering what the per-device insert-time prune
  // in deviceSocket.js misses: removed/idle devices that never insert again, and
  // the heartbeat.js offline_timeout insert that bypasses logDeviceStatus. Default
  // is LOWER than the old hardcoded 7 days (the reporter's bloat happened under 7d);
  // 2-3 days is plenty for the dashboard's 24h uptime view + diagnostics.
  statusLogRetentionDays: parseFloat(process.env.STATUS_LOG_RETENTION_DAYS) || 3,

  // #142 content-ack dedup window (deviceSocket.js). A device (esp. older apps)
  // can spam "content <id>: ready" for the same item; suppress identical
  // (device_id, content_id, status) reports within this window. A status CHANGE
  // has a different key and passes immediately. In-memory; resets on restart.
  contentAckDedupMs: parseInt(process.env.CONTENT_ACK_DEDUP_MS) || 10000,
};
