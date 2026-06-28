const { db, pruneStatusLog } = require('../db/database');
const config = require('../config');
const { deviceRoom, emitToWorkspace } = require('../lib/socket-rooms');

// Track connected device sockets: deviceId -> { socketId, lastHeartbeat }
const deviceConnections = new Map();

function startHeartbeatChecker(io) {
  // #142: sweep stale device_status_log rows once at startup (recovers a bloated
  // table immediately after a deploy), then again on each interval below.
  pruneStatusLog();

  setInterval(() => {
    const now = Date.now();
    const dashboardNs = io.of('/dashboard');

    // Check database for devices that should be offline
    const onlineDevices = db.prepare("SELECT id, last_heartbeat FROM devices WHERE status = 'online'").all();

    for (const device of onlineDevices) {
      const conn = deviceConnections.get(device.id);
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
        try {
          db.prepare('INSERT INTO device_status_log (device_id, status) VALUES (?, ?)').run(device.id, 'offline_timeout');
        } catch (_) {}
      }
    }

    // Cleanup: delete unclaimed provisioning devices older than 24 hours.
    pruneProvisioningDevices();

    // Cleanup: prune play logs older than 90 days
    db.prepare(`
      DELETE FROM play_logs WHERE started_at < strftime('%s','now') - (90 * 86400)
    `).run();

    // #142: global device_status_log retention sweep (all devices, incl. removed/idle
    // and the offline_timeout insert path that bypasses the per-device prune).
    pruneStatusLog();

    // Cleanup: expired team invites
    db.prepare(`
      DELETE FROM team_invites WHERE expires_at < strftime('%s','now')
    `).run();

    // Cleanup: expired workspace invites
    db.prepare(`
      DELETE FROM workspace_invites WHERE expires_at < strftime('%s','now')
    `).run();

  }, config.heartbeatInterval);
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

// #142: sweep unclaimed provisioning devices older than 24h. The window previously
// read `365 * 86400` (a YEAR), contradicting its own "older than 24 hours" comment,
// so socket-register pairing junk lingered far longer than intended. Imported
// devices keep a user_id and are preserved so they can be re-paired. Extracted from
// the interval above so the correctness fix is unit-testable. Returns rows deleted.
function pruneProvisioningDevices() {
  return db.prepare(`
    DELETE FROM devices
    WHERE status = 'provisioning' AND user_id IS NULL
    AND created_at < strftime('%s','now') - (24 * 3600)
  `).run().changes;
}

module.exports = {
  startHeartbeatChecker,
  registerConnection,
  updateHeartbeat,
  removeConnection,
  getConnection,
  getAllConnections,
  pruneProvisioningDevices
};
