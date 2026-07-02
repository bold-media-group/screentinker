const { db, pruneStatusLog } = require('../db/database');
const config = require('../config');
const { deviceRoom, emitToWorkspace } = require('../lib/socket-rooms');
const statusLogWriter = require('../lib/status-log-writer');
const { chunkedDelete, currentBand, yieldTick } = require('../lib/chunked-prune'); // #146 non-blocking sweeps

// Track connected device sockets: deviceId -> { socketId, lastHeartbeat }
const deviceConnections = new Map();

function startHeartbeatChecker(io) {
  // #146: startup sweep is chunked + async + fire-and-forget + NOT band-gated, so a
  // bloated device_status_log self-heals on next deploy WITHOUT freezing boot (the old
  // whole-table sort froze boot 40-48s -> healthcheck fail -> restart loop). It
  // trickles in bounded batches while the server comes up and serves.
  pruneStatusLog({ bandGate: false }).catch(() => {});

  // #146: start the batched device_status_log flush loop.
  statusLogWriter.start();

  const deviceNs = io.of('/device');

  setInterval(() => {
    const now = Date.now();
    const dashboardNs = io.of('/dashboard');

    // #146 BILLING: credit currently-connected devices' usage for this interval.
    // Fire-and-forget + never throws into the interval (billing must not perturb the
    // heartbeat). Reads the same live presence map as the offline check below.
    accrueUsage(now).catch(() => {});

    // Check database for devices that should be offline
    const onlineDevices = db.prepare("SELECT id, last_heartbeat FROM devices WHERE status = 'online'").all();

    for (const device of onlineDevices) {
      const conn = deviceConnections.get(device.id);

      // #146: a device with a live, still-connected socket is UP, even if its last
      // heartbeat event is stuck behind a lagged event loop. Marking it offline on a
      // stale in-memory lastHeartbeat was the second false-offline cause (the screen
      // is online and playing, the CMS says offline). The socket still being in the
      // /device namespace is the authoritative liveness signal — trust it over the
      // (possibly queued) heartbeat clock. If the socket is genuinely gone, conn is
      // either absent or points at a socket no longer in the namespace, and we fall
      // through to the timeout below.
      if (conn && deviceNs.sockets.has(conn.socketId)) continue;

      const lastBeat = conn ? conn.lastHeartbeat : (device.last_heartbeat ? device.last_heartbeat * 1000 : 0);

      if (now - lastBeat > config.heartbeatTimeout) {
        db.prepare("UPDATE devices SET status = 'offline', updated_at = strftime('%s','now') WHERE id = ?")
          .run(device.id);
        deviceConnections.delete(device.id);

        // Notify dashboard (workspace-scoped via the device's room).
        emitToWorkspace(dashboardNs, deviceRoom(device.id), 'dashboard:device-status', {
          device_id: device.id,
          status: 'offline',
          telemetry: null
        });

        console.log(`Device ${device.id} marked offline (heartbeat timeout)`);
        // #146: batch through the coalescing writer (was an immediate INSERT here).
        statusLogWriter.record(device.id, 'offline_timeout');
      }
    }

    // #146: all table-growth maintenance runs OFF the interval body — async, chunked,
    // band-gated, re-entrancy-guarded — so a sweep can never block the loop or stack.
    // The offline-marking above stays synchronous (it's the core heartbeat function).
    runMaintenance();

  }, config.heartbeatInterval);
}

// #146: batched play-log prune (idx_play_logs_time), chunked so a 90-day backlog
// trims across many bounded DELETEs instead of one large statement.
const _delPlayLogs = db.prepare('DELETE FROM play_logs WHERE rowid IN (SELECT rowid FROM play_logs WHERE started_at < ? LIMIT ?)');
async function prunePlayLogs() {
  const cutoff = Math.floor(Date.now() / 1000) - (90 * 86400);
  return (await chunkedDelete((lim) => _delPlayLogs.run(cutoff, lim).changes, { batch: config.statusLogPruneBatch })).deleted;
}

// #146 interval maintenance — band-gated (skip while loaded; runs next tick) and
// re-entrancy-guarded (a long run never stacks with the next interval). Never throws
// into the interval. NOT for startup (see the un-gated startup prune above).
let _maintRunning = false;
async function runMaintenance() {
  if (_maintRunning) return;
  if (config.maintenanceBandGateEnabled && currentBand() !== 'normal') return;   // #146 P1.3 kill switch
  _maintRunning = true;
  try {
    await pruneProvisioningDevices();
    await prunePlayLogs();
    await pruneStatusLog({ bandGate: true });   // per-device chunked; own re-entrancy
    await pruneUsageDaily();                     // #146 BILLING rollup retention (chunked)
    // Expiry sweeps on small tables — single cheap statements, bounded by table size.
    db.prepare("DELETE FROM team_invites WHERE expires_at < strftime('%s','now')").run();
    db.prepare("DELETE FROM workspace_invites WHERE expires_at < strftime('%s','now')").run();
  } catch (_) { /* maintenance must never crash the interval */ } finally { _maintRunning = false; }
}

function registerConnection(deviceId, socketId) {
  deviceConnections.set(deviceId, { socketId, lastHeartbeat: Date.now() });
}

function updateHeartbeat(deviceId) {
  const conn = deviceConnections.get(deviceId);
  if (conn) conn.lastHeartbeat = Date.now();
}

function removeConnection(deviceId) {
  deviceConnections.delete(deviceId);
}

function getConnection(deviceId) {
  return deviceConnections.get(deviceId);
}

function getAllConnections() {
  return deviceConnections;
}

// #146: LIVE connected-device count — the set with a live socket THIS INSTANT. Cheap
// in-memory read. Distinct from devices.status='online' (persisted, lags by the
// offline-timeout). Surfaced as /api/status.devices_connected.
function getConnectedCount() {
  return deviceConnections.size;
}

// #146 BILLING accumulator — credit each currently-connected device's today-row with the
// seconds elapsed since the last accrual. Retention-INDEPENDENT: it reuses the SAME live
// presence map as devices_connected (never reconstructs online time from status_log,
// which is only 3-day). Cheap + non-blocking: chunked UPSERTs, one bounded transaction
// per chunk, yielding between chunks. The per-accrual credit is CAPPED (accrualCapSeconds)
// so a stalled loop or restart gap can't inject a bogus large credit; the DAILY total is
// capped at 86400 in the UPSERT itself. Day is the UTC calendar day of the tick.
const _usageUpsert = db.prepare(`
  INSERT INTO device_usage_daily (device_id, day, online_seconds) VALUES (?, ?, ?)
  ON CONFLICT(device_id, day) DO UPDATE SET online_seconds = MIN(86400, online_seconds + excluded.online_seconds)
`);
let _lastAccrue = 0;
let _accrualRunning = false;
async function accrueUsage(now = Date.now()) {
  if (_accrualRunning) return 0;                        // never stack; elapsed-based credit self-heals a skipped tick
  if (_lastAccrue === 0) { _lastAccrue = now; return 0; } // first tick establishes the baseline; credit nothing
  const credit = Math.min(Math.floor((now - _lastAccrue) / 1000), config.billing.accrualCapSeconds);
  _lastAccrue = now;
  if (credit <= 0) return 0;
  const ids = Array.from(deviceConnections.keys());
  if (!ids.length) return 0;
  const day = new Date(now).toISOString().slice(0, 10);
  _accrualRunning = true;
  try {
    const upsertMany = db.transaction((slice) => { for (const id of slice) _usageUpsert.run(id, day, credit); });
    const batch = config.billing.accrualBatch;
    for (let i = 0; i < ids.length; i += batch) {
      upsertMany(ids.slice(i, i + batch));
      if (i + batch < ids.length) await yieldTick();     // keep a huge fleet's accrual off the event loop
    }
  } finally { _accrualRunning = false; }
  return ids.length;
}

// #146 BILLING: prune the daily rollup beyond retention (chunked, so it can never
// bloat-then-freeze). `day` is a sortable 'YYYY-MM-DD' string → lexical < is a date <.
const _delUsage = db.prepare('DELETE FROM device_usage_daily WHERE rowid IN (SELECT rowid FROM device_usage_daily WHERE day < ? LIMIT ?)');
async function pruneUsageDaily() {
  const cutoff = new Date(Date.now() - config.billing.usageRetentionDays * 86400 * 1000).toISOString().slice(0, 10);
  return (await chunkedDelete((lim) => _delUsage.run(cutoff, lim).changes, { batch: config.statusLogPruneBatch })).deleted;
}

// #142: sweep unclaimed provisioning devices older than 24h (imported devices keep a
// user_id and are preserved). #146: now async + CHUNKED (rides idx_devices_provisioning)
// so a provisioning-junk flood can't delete-cascade a huge batch in one synchronous
// statement. Returns rows deleted. NOTE: async now — callers must await.
const _delProvisioning = db.prepare(`
  DELETE FROM devices WHERE rowid IN (
    SELECT rowid FROM devices
    WHERE status = 'provisioning' AND user_id IS NULL AND created_at < ?
    LIMIT ?
  )
`);
async function pruneProvisioningDevices() {
  const cutoff = Math.floor(Date.now() / 1000) - (24 * 3600);
  return (await chunkedDelete((lim) => _delProvisioning.run(cutoff, lim).changes, { batch: config.statusLogPruneBatch })).deleted;
}

module.exports = {
  startHeartbeatChecker,
  registerConnection,
  updateHeartbeat,
  removeConnection,
  getConnection,
  getAllConnections,
  getConnectedCount,
  pruneProvisioningDevices,
  accrueUsage,
  pruneUsageDaily,
  __resetAccrual: () => { _lastAccrue = 0; },   // #146 test hook: reset the accrual baseline
};
