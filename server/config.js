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
};
