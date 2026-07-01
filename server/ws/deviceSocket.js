const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, pruneTelemetry, pruneScreenshots } = require('../db/database');
const config = require('../config');
const heartbeat = require('../services/heartbeat');
const commandQueue = require('../lib/command-queue');
const reconnectThrottle = require('../lib/reconnect-throttle');
const contentAckLimiter = require('../lib/content-ack-limiter');
const statusLogWriter = require('../lib/status-log-writer');
const { protectSocket } = require('../lib/safe-socket');
const flapLimiter = require('../lib/flap-limiter');
const { resolveIdentity } = require('../lib/device-identity');
const logCoalescer = require('../lib/log-coalescer');
const loopLag = require('../services/loop-lag');

// Debounce window for marking a device offline on socket disconnect. Brief
// flap (Wi-Fi blip, Engine.IO ping miss, server-side eviction-then-reconnect)
// shouldn't toggle the dashboard. If a fresh register lands within this
// window, the pending offline transition is cancelled. Per-device timer is
// stored here; cleared by the register handlers and by stale-disconnect
// guards. In-memory only - the heartbeat checker is the safety net for
// server-restart-during-grace-window edge cases (any 'online' rows whose
// last_heartbeat is older than heartbeatTimeout get marked offline by the
// next checker sweep within heartbeatInterval).
const pendingOfflines = new Map();
const OFFLINE_DEBOUNCE_MS = 5000;

// #146: socket ids we force-disconnected via evictPriorSocket because a NEWER socket
// took over the device. evictPriorSocket runs at register time BEFORE the new socket
// is put in the connection map (registerConnection is later in the same handler), so
// the evicted socket's disconnect handler would see the still-old map entry, pass the
// stale-disconnect guard, and ARM a fresh offline timer — re-marking the device that
// just reconnected offline (the self-reset race). Tagging the id here lets that
// disconnect handler bail out instead of arming a timer. Drained on consumption.
const evictedSockets = new Set();

// Proof-of-play write throttle. A player stuck in a tight loop (e.g. a playlist
// with 0-second item durations) fires device:play-event 'play_start' several
// times per second; unthrottled this once bloated play_logs to ~900k rows
// (~3 inserts/sec from a single web player). Cap proof-of-play inserts to at
// most one per device per PLAY_LOG_MIN_GAP_MS. The live dashboard progress
// event is still forwarded every time, so the UI is unaffected. In-memory only.
const lastPlayLogAt = new Map();
const PLAY_LOG_MIN_GAP_MS = 2000;

// #142 dedup + #143 per-device rate budget + global loop-lag valve for content-acks
// all live in one control: lib/content-ack-limiter.js (required above as
// contentAckLimiter). Kept out of this file so there is a single limiter on the path.

// #143 fingerprint-reclaim deferral log throttle: deviceId -> last-logged ms, so a
// device retrying reclaim every ~2s logs at most once per reclaimRejectLogWindowMs.
const lastReclaimRejectLogAt = new Map();
const { getUserPlan, getUserDeviceCount } = require('../middleware/subscription');
// Phase 2.3: deviceRoom() resolves a device_id to its workspace room so
// dashboardNs.emit can be scoped instead of broadcast platform-wide.
const { deviceRoom, emitToWorkspace } = require('../lib/socket-rooms');

function emitToDeviceWorkspace(dashboardNs, deviceId, event, payload) {
  emitToWorkspace(dashboardNs, deviceRoom(deviceId), event, payload);
}

// In-memory store for latest screenshot per device (avoids disk writes during streaming)
let lastScreenshots = {};

// Generate a random device token
function generateDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Validate device_id + device_token pair. Returns true if valid.
function validateDeviceToken(deviceId, token) {
  if (!deviceId || !token) return false;
  const row = db.prepare('SELECT device_token FROM devices WHERE id = ?').get(deviceId);
  if (!row || !row.device_token) return false;
  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(row.device_token), Buffer.from(token));
  } catch {
    return false;
  }
}

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address;
}

// #146: route status transitions through the batched, coalescing writer instead of
// an immediate INSERT-per-transition. A flapping device no longer writes a row per
// flap (the table-bloat feedback loop); the per-device age prune now lives in the
// writer and uses config.statusLogRetentionDays (was a hardcoded 7 days here — one
// source of truth). devices.status is still updated immediately by callers; only
// this audit log is deferred to the next flush.
function logDeviceStatus(deviceId, status) {
  statusLogWriter.record(deviceId, status);
}


// Build playlist payload with layout and zones
// Reads from published_snapshot (Phase 3) so draft edits don't affect live devices
function buildPlaylistPayload(deviceId) {
  const device = db.prepare('SELECT playlist_id, layout_id, orientation, wall_id, timezone, reported_timezone FROM devices WHERE id = ?').get(deviceId);

  let assignments = [];
  if (device?.playlist_id) {
    const playlist = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(device.playlist_id);
    if (playlist?.published_snapshot) {
      try { assignments = JSON.parse(playlist.published_snapshot); } catch (e) { assignments = []; }
    }
  }

  let layout = null;
  if (device?.layout_id) {
    layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(device.layout_id);
    if (layout) {
      layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layout.id);
    }
  }

  // Wall membership flips the player into wall mode. The renderer needs two
  // rectangles in canvas-space: this device's screen rect, and the wall's
  // player rect. The intersection is what this screen displays. The leader
  // drives playback; followers track via wall:sync.
  let wall_config = null;
  if (device?.wall_id) {
    const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(device.wall_id);
    const pos = db.prepare('SELECT * FROM video_wall_devices WHERE wall_id = ? AND device_id = ?').get(device.wall_id, deviceId);
    if (wall && pos) {
      const baseW = 320, baseH = 180;
      const bezelH = wall.bezel_h_mm || 0;
      const bezelV = wall.bezel_v_mm || 0;

      // Backfill canvas rect from grid math when canvas_* is unset (legacy
      // walls that haven't been touched by the new editor yet). Coords are
      // rounded to integers so sub-pixel drift can't cause two visually
      // identical rects to compute different stage offsets.
      const screenRect = {
        x: Math.round(pos.canvas_x ?? (pos.grid_col * (baseW + bezelH))),
        y: Math.round(pos.canvas_y ?? (pos.grid_row * (baseH + bezelV))),
        w: Math.round(pos.canvas_width ?? baseW),
        h: Math.round(pos.canvas_height ?? baseH),
      };

      // Player rect defaults to the bounding box of all screens on the wall.
      let playerRect;
      if (wall.player_x !== null && wall.player_x !== undefined) {
        playerRect = { x: wall.player_x, y: wall.player_y, w: wall.player_width, h: wall.player_height };
      } else {
        const all = db.prepare('SELECT * FROM video_wall_devices WHERE wall_id = ?').all(wall.id);
        let x = Infinity, y = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const p of all) {
          const px = p.canvas_x ?? (p.grid_col * (baseW + bezelH));
          const py = p.canvas_y ?? (p.grid_row * (baseH + bezelV));
          const pw = p.canvas_width ?? baseW;
          const ph = p.canvas_height ?? baseH;
          if (px < x) x = px;
          if (py < y) y = py;
          if (px + pw > x2) x2 = px + pw;
          if (py + ph > y2) y2 = py + ph;
        }
        playerRect = isFinite(x)
          ? { x, y, w: x2 - x, h: y2 - y }
          : { x: 0, y: 0, w: baseW, h: baseH };
      }
      // Round the player rect too — same rationale.
      playerRect = {
        x: Math.round(playerRect.x), y: Math.round(playerRect.y),
        w: Math.round(playerRect.w), h: Math.round(playerRect.h),
      };

      wall_config = {
        wall_id: wall.id,
        screen_rect: screenRect,
        player_rect: playerRect,
        is_leader: wall.leader_device_id === deviceId,
        rotation: pos.rotation || 0,
      };
    }
  }

  // #74/#75: the effective IANA timezone the player evaluates schedule blocks in.
  // An explicit (non-default) devices.timezone override wins; otherwise the player's
  // last OS-reported zone; otherwise null = the player trusts its own OS clock.
  const tzOverride = (device?.timezone && device.timezone !== 'UTC') ? device.timezone : null;
  const timezone = tzOverride || device?.reported_timezone || null;
  // #104: shared shape + zone-reset tail so the device payload and the dashboard
  // preview payload (GET /api/playlists/:id/preview-payload) can never drift.
  return assemblePayload({ assignments, layout, orientation: device?.orientation || 'landscape', wall_config, timezone });
}

// #104: the canonical player payload shape, shared by the device path
// (buildPlaylistPayload) and the device-free dashboard preview.
// Zone reset: if this isn't a real multi-zone layout (single zone or no layout),
// strip any leftover zone_id so content falls back to the fullscreen renderer
// instead of binding to a now-gone left/right zone and never playing.
function assemblePayload({ assignments, layout, orientation, wall_config, timezone }) {
  let a = Array.isArray(assignments) ? assignments : [];
  const zoneCount = layout?.zones?.length || 0;
  if (zoneCount < 2) a = a.map(x => (x && x.zone_id != null ? { ...x, zone_id: null } : x));
  return {
    assignments: a,
    layout: layout || null,
    orientation: orientation || 'landscape',
    wall_config: wall_config || null,
    timezone: timezone || null,
  };
}

// Check if a device should show trial expired screen
function checkDeviceAccess(deviceId) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device || !device.user_id) return { allowed: true };

  const plan = getUserPlan(device.user_id);
  if (!plan) return { allowed: true };

  // Check if trial expired and over free limit
  if (plan.trial_started && !plan.trial_active && plan.plan_name === 'free') {
    const deviceCount = getUserDeviceCount(device.user_id);
    // Get this device's position (ordered by created_at)
    const userDevices = db.prepare('SELECT id FROM devices WHERE user_id = ? ORDER BY created_at ASC').all(device.user_id);
    const deviceIndex = userDevices.findIndex(d => d.id === deviceId);

    // Only the first device (within free limit) is allowed
    if (deviceIndex >= plan.max_devices) {
      return {
        allowed: false,
        reason: 'trial_expired',
        message: 'Trial Expired',
        detail: 'Upgrade your plan to continue using this display.',
      };
    }
  }

  // Check if over plan device limit (non-trial)
  if (!plan.trial_started && plan.max_devices > 0) {
    const userDevices = db.prepare('SELECT id FROM devices WHERE user_id = ? ORDER BY created_at ASC').all(device.user_id);
    const deviceIndex = userDevices.findIndex(d => d.id === deviceId);
    if (deviceIndex >= plan.max_devices) {
      return {
        allowed: false,
        reason: 'device_limit',
        message: 'Device Limit Reached',
        detail: 'Upgrade your plan to activate this display.',
      };
    }
  }

  return { allowed: true };
}

module.exports = function setupDeviceSocket(io) {
  // Expose helpers for use by route handlers
  module.exports.lastScreenshots = lastScreenshots;
  module.exports.buildPlaylistPayload = buildPlaylistPayload;
  module.exports.assemblePayload = assemblePayload;
  module.exports.generateDeviceToken = generateDeviceToken;
  const deviceNs = io.of('/device');
  const dashboardNs = io.of('/dashboard');

  // Disconnect any existing socket that is currently registered for this device_id.
  // Called when a fresh registration comes in for the same device so the old (likely
  // half-dead) socket can't fire its disconnect handler and clobber the new entry.
  function evictPriorSocket(deviceId, exceptSocketId) {
    const prior = heartbeat.getConnection(deviceId);
    if (!prior || prior.socketId === exceptSocketId) return;
    const oldSocket = deviceNs.sockets.get(prior.socketId);
    if (oldSocket) {
      console.log(`Evicting prior socket ${prior.socketId} for device ${deviceId}`);
      // Mark BEFORE disconnect: disconnect(true) fires the old socket's 'disconnect'
      // handler synchronously, so the flag must already be set when it runs.
      evictedSockets.add(prior.socketId);
      try { oldSocket.disconnect(true); } catch (_) { evictedSockets.delete(prior.socketId); }
    }
  }

  deviceNs.on('connection', (socket) => {
    console.log(`Device socket connected: ${socket.id}`);
    let currentDeviceId = null;
    let authenticated = false; // Track whether this socket has been authenticated

    // #146: wrap every handler on THIS socket so a throw disconnects only this device
    // (logged with its id) instead of crashing the whole server. Backstop to the
    // per-site try/catch in the handlers below.
    protectSocket(socket, () => currentDeviceId);

    // Device registers with a pairing code (first time) or device_id + device_token (reconnect)
    socket.on('device:register', (data) => {
      const { pairing_code, device_id, device_token, device_info, fingerprint } = data;

      // #146: resolve identity ONCE via the SNAT-safe chain (device_id -> fingerprint
      // -> token -> global anon), used by BOTH the operator block and the flap limiter.
      const ident = resolveIdentity({ device_id, fingerprint, device_token });

      // #143 operator KILL SWITCH — the FIRST gate, before the fingerprint block, the
      // throttle, any DB writes, or playlist build. #146: resolve the effective
      // device_id via the identity chain (device_id directly, OR fingerprint->device_id)
      // so a blocked device that reconnects WITHOUT a device_id is STILL caught — the
      // old `if (device_id)` gate let a device_id-less reconnect slip past. Settable by
      // DIRECT SQLite during an outage (dashboard down), takes effect on the device's
      // NEXT register with NO restart (the row is re-read every register):
      //   UPDATE devices SET blocked = 1 WHERE id = '<device_id>';   (0 to unblock)
      // Unlike nulling the token (#143: that re-provisioned instead of locking out),
      // `blocked` is an explicit, enforceable lever. Also settable via the dashboard
      // (routes/devices.js POST /:id/block) — same DB write, same next-register effect.
      if (ident.deviceId) {
        const blk = db.prepare('SELECT blocked FROM devices WHERE id = ?').get(ident.deviceId);
        if (blk && blk.blocked) {
          console.warn(`[blocked] refused device ${ident.deviceId} (operator block, via ${ident.kind})`);
          socket.emit('device:auth-error', { error: 'Device blocked' });
          process.nextTick(() => { try { socket.disconnect(true); } catch (_) { /* */ } });
          return;
        }
      }

      // #146 Item B: SUSTAINED flap limiter — BEFORE fingerprint tracking, throttle,
      // DB writes, or playlist build, so a refusal is cheap. Skips same-socket playlist
      // refreshes (currentDeviceId===device_id — a periodic pull, not a new connection).
      // Keyed via the same SNAT-safe identity, NEVER IP.
      const isRefreshConnect = device_id && currentDeviceId === device_id;
      if (!isRefreshConnect) {
        const fv = flapLimiter.check(ident.key);
        if (!fv.allow) {
          console.warn(`[flap] refused ${ident.kind} ${ident.deviceId || ident.key} reason=${fv.reason} retry=${fv.retryAfterMs}ms trips=${fv.trips || 0}`);
          // Optional auto-quarantine (Item D): a device_id-resolved HARD flapper is
          // blocked=1 so it stops entirely rather than being refused forever.
          if (fv.tripped && ident.deviceId && config.connectRateQuarantineTrips > 0 && (fv.trips || 0) >= config.connectRateQuarantineTrips) {
            try { db.prepare('UPDATE devices SET blocked = 1 WHERE id = ?').run(ident.deviceId); console.warn(`[flap] auto-quarantined ${ident.deviceId} after ${fv.trips} trips (blocked=1)`); } catch (_) { /* */ }
          }
          socket.emit('device:throttled', { retry_after_ms: fv.retryAfterMs, reason: 'connect_rate' });
          process.nextTick(() => { try { socket.disconnect(true); } catch (_) { /* */ } });
          return;
        }
      }

      // Track device fingerprint to prevent reinstall abuse
      if (fingerprint) {
        try {
          const existing = db.prepare('SELECT * FROM device_fingerprints WHERE fingerprint = ?').get(fingerprint);
          if (existing) {
            db.prepare("UPDATE device_fingerprints SET last_seen = strftime('%s','now'), device_id = ? WHERE fingerprint = ?")
              .run(device_id || existing.device_id, fingerprint);
            // If this fingerprint was previously registered to a different device, block the new registration
            if (!device_id && existing.device_id && pairing_code) {
              // Someone reinstalled - link them back to existing device
              const oldDevice = db.prepare('SELECT * FROM devices WHERE id = ?').get(existing.device_id);
              if (oldDevice) {
                // Fingerprint reclaim guard: a leaked/duplicated fingerprint shouldn't be enough
                // to take over a LIVE device. #143: decide "still alive" from RUNTIME signals —
                // a live socket, OR a genuinely recent heartbeat (within the settle window). The
                // old check used `secondsSince < 24h`, which treated a device merely offline <24h
                // as "active": a legitimately-gone device (liveConn=false, status=offline, stale
                // heartbeat) could never reclaim and retried every ~2s, flooding logs (Bold beta1
                // / 2febcaa9, 1984694c, 139159eb). NOT a missing clear — liveConn IS removed on
                // disconnect + the offline-timeout sweep, and status IS set offline on both; the
                // 24h TIME gate was the cause. A device gone by every runtime signal is reclaimable.
                const liveConn = heartbeat.getConnection(existing.device_id);
                const lastBeat = oldDevice.last_heartbeat || 0;
                const secondsSince = Math.floor(Date.now() / 1000) - lastBeat;
                const stillAlive = !!liveConn || secondsSince < config.reclaimSettleSeconds;
                if (stillAlive) {
                  // Log at most once per device per window so a retrying/stuck device can't flood stdout.
                  const nowMs = Date.now();
                  if (nowMs - (lastReclaimRejectLogAt.get(existing.device_id) || 0) >= config.reclaimRejectLogWindowMs) {
                    lastReclaimRejectLogAt.set(existing.device_id, nowMs);
                    console.warn(`Fingerprint reclaim deferred for ${existing.device_id}: still settling (status=${oldDevice.status}, ${secondsSince}s since heartbeat, liveConn=${!!liveConn}); reclaimable after ${config.reclaimSettleSeconds}s offline`);
                  }
                  socket.emit('device:auth-error', {
                    error: `This display was recently active. If you reinstalled the app, retry after it has been offline for ${config.reclaimSettleSeconds} seconds.`
                  });
                  return;
                }
                lastReclaimRejectLogAt.delete(existing.device_id); // reclaim proceeding — clear any deferral log state

                // Fingerprint matched — this is a reinstalled app reconnecting to its old device.
                // Issue a fresh token so the app can authenticate going forward.
                const newToken = generateDeviceToken();
                db.prepare('UPDATE devices SET device_token = ? WHERE id = ?').run(newToken, existing.device_id);
                console.log(`Fingerprint match: linking reinstalled app to existing device ${existing.device_id} (new token issued)`);
                authenticated = true;
                // Cancel any pending offline timer - device is back in the grace window
                if (pendingOfflines.has(existing.device_id)) {
                  clearTimeout(pendingOfflines.get(existing.device_id));
                  pendingOfflines.delete(existing.device_id);
                }
                evictPriorSocket(existing.device_id, socket.id);
                db.prepare("UPDATE devices SET status = 'online', last_heartbeat = strftime('%s','now'), ip_address = ?, updated_at = strftime('%s','now') WHERE id = ?")
                  .run(getClientIp(socket), existing.device_id);
                socket.emit('device:registered', { device_id: existing.device_id, device_token: newToken, status: 'online' });
                // If device was already claimed by a user, tell the player it's paired
                if (oldDevice.user_id) {
                  socket.emit('device:paired', { name: oldDevice.name || 'Display' });
                }
                currentDeviceId = existing.device_id;
                heartbeat.registerConnection(existing.device_id, socket.id);
                socket.join(existing.device_id);
                logDeviceStatus(existing.device_id, 'online');
                emitToDeviceWorkspace(dashboardNs, existing.device_id, 'dashboard:device-status', { device_id: existing.device_id, status: 'online' });
                // Flush any commands/playlist-updates queued while this device was offline.
                commandQueue.flushQueue(deviceNs, existing.device_id, buildPlaylistPayload);
                // Send playlist
                const access = checkDeviceAccess(existing.device_id);
                if (!access.allowed) {
                  socket.emit('device:playlist-update', { assignments: [], suspended: true, message: access.message, detail: access.detail });
                } else {
                  socket.emit('device:playlist-update', buildPlaylistPayload(existing.device_id));
                }
                return;
              }
            }
          } else if (device_id || pairing_code) {
            // device_id can be stale (e.g. a reconnect after the device row was
            // deleted). device_fingerprints.device_id has an FK to devices(id), and
            // INSERT OR IGNORE does NOT suppress FK violations - so null out an
            // unknown id instead of letting it throw (was a caught, noisy error).
            const fpDeviceId = (device_id && db.prepare('SELECT 1 FROM devices WHERE id = ?').get(device_id)) ? device_id : null;
            db.prepare("INSERT OR IGNORE INTO device_fingerprints (fingerprint, device_id) VALUES (?, ?)")
              .run(fingerprint, fpDeviceId);
          }
        } catch (e) {
          console.error('Fingerprint tracking error:', e.message);
        }
      }

      if (device_id) {
        // Reconnecting known device — require valid token
        const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(device_id);
        if (device) {
          // A re-register on the SAME socket is a playlist REFRESH, not a reconnect: the
          // player re-emits device:register every ~45-60s (requestPlaylistRefresh) to pull a
          // fresh playlist, and the socket never dropped. currentDeviceId is still null on a
          // genuinely new socket and already === device_id on a same-socket refresh. Tracking
          // this stops a healthy device (~2000 re-registers/day) from spamming "Device
          // reconnected" and reading as connection instability (#134 — there were 1415
          // "reconnected" logs against only ~30 real socket connects and 0 heartbeat timeouts).
          const isPlaylistRefresh = currentDeviceId === device_id;
          // #143 AUTH FIX: an already-provisioned device (it has a row — every row,
          // even `provisioning`, is created WITH a token) presenting a null/empty/
          // invalid token is NOT authenticated — reject and disconnect. The old guard
          // `device.device_token && !validate(...)` short-circuited on a NULL stored
          // token, so nulling a device's token RE-PROVISIONED it (auth skipped + a
          // fresh token minted) instead of locking it out (Bold #143 / 75c2a08a).
          // validateDeviceToken already returns false for null-stored/missing/mismatch.
          // First pairing is the pairing_code path below (no device_id) — unaffected.
          if (!validateDeviceToken(device_id, device_token)) {
            console.warn(`Invalid/missing device token for ${device_id} from ${getClientIp(socket)} — received_len=${(device_token || '').length}, has_stored_token=${!!device.device_token}`);
            socket.emit('device:auth-error', { error: 'Invalid device token' });
            return;
          }

          // #142: per-device reconnect throttle. Only GENUINE reconnects (a new
          // socket) count — same-socket playlist refreshes (isPlaylistRefresh) are
          // exempt. This runs BEFORE the heavy register work (DB writes, playlist
          // build) so a single flapping device cannot saturate the event loop. The
          // verdict is per-device; global lag only scales an already-flagged
          // device's backoff, never gates a healthy one.
          if (!isPlaylistRefresh) {
            const verdict = reconnectThrottle.check(device_id);
            if (!verdict.allow) {
              console.warn(`[throttle] device ${device_id} reconnect throttled: reason=${verdict.reason} band=${verdict.band} observed=${verdict.observed}/${verdict.allowed} per ${config.reconnectWindowMs}ms -> backoff ${verdict.retryAfterMs}ms (level ${verdict.level})`);
              socket.emit('device:throttled', { retry_after_ms: verdict.retryAfterMs, reason: 'reconnect_rate' });
              // nextTick disconnect so the throttle notice flushes first.
              process.nextTick(() => { try { socket.disconnect(true); } catch (_) { /* */ } });
              return;
            }
          }

          currentDeviceId = device_id;
          authenticated = true;
          // Cancel any pending offline timer - device is back in the grace window
          if (pendingOfflines.has(device_id)) {
            clearTimeout(pendingOfflines.get(device_id));
            pendingOfflines.delete(device_id);
          }
          evictPriorSocket(device_id, socket.id);
          db.prepare("UPDATE devices SET status = 'online', last_heartbeat = strftime('%s','now'), ip_address = ?, updated_at = strftime('%s','now') WHERE id = ?")
            .run(getClientIp(socket), device_id);

          // #143: past the validateDeviceToken gate above the stored token is
          // guaranteed non-null, so we just echo it back. The old "mint a token for a
          // null-token device" path is removed — that was the re-provisioning vector.
          const tokenToSend = device.device_token;

          if (device_info) {
            db.prepare(`UPDATE devices SET android_version = ?, app_version = ?, screen_width = ?, screen_height = ?, render_width = ?, render_height = ?,
              ota_status = ?, ota_target_version = ?, ota_attempts = ?, ota_updated_at = strftime('%s','now') WHERE id = ?`)
              .run(device_info.android_version, device_info.app_version, device_info.screen_width, device_info.screen_height, device_info.render_width ?? null, device_info.render_height ?? null,
                // #139 Phase 2: older APKs don't send these — default to a clean 'none' state.
                device_info.ota_status ?? 'none', device_info.ota_target_version ?? null, device_info.ota_attempts ?? 0,
                device_id);
          }

          heartbeat.registerConnection(device_id, socket.id);
          socket.join(device_id);
          socket.emit('device:registered', { device_id, device_token: tokenToSend, status: 'online' });
          // #143: a device paired/claimed server-side (user_id set) that RECONNECTS must be told
          // it's paired — the app leaves the Connect page ONLY on 'device:paired' (web: hides the
          // setup screen; Android ProvisioningActivity.onPaired -> MainActivity). The
          // /api/provision/pair endpoint pushes device:paired to a LIVE socket at pair time
          // (server.js), but a screen paired while disconnected — or that reconnects after pairing
          // — never received it and sat on the Connect page forever showing the URL (Bold #143).
          // Re-send the exact event the client already listens for; no client change needed.
          if (device.user_id) {
            socket.emit('device:paired', { device_id, name: device.name || 'Display' });
          }
          logDeviceStatus(device_id, 'online');
          // Flush any commands/playlist-updates queued while this device was offline.
          commandQueue.flushQueue(deviceNs, device_id, buildPlaylistPayload);

          // If this device is part of a wall, re-evaluate leadership.
          // Preferred leader = online member with smallest (canvas_x +
          // canvas_y), falling back to grid 0,0. If the original leader
          // (top-left tile) is back, they reclaim the role and peers re-sync.
          if (device.wall_id) {
            try {
              const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(device.wall_id);
              if (wall) {
                const candidates = db.prepare(`
                  SELECT vwd.device_id, vwd.canvas_x, vwd.canvas_y, vwd.grid_col, vwd.grid_row
                  FROM video_wall_devices vwd
                  JOIN devices d ON d.id = vwd.device_id
                  WHERE vwd.wall_id = ? AND d.status = 'online'
                `).all(wall.id);
                if (candidates.length > 0) {
                  const score = (c) => (c.canvas_x ?? c.grid_col * 320) + (c.canvas_y ?? c.grid_row * 180);
                  candidates.sort((a, b) => score(a) - score(b));
                  const preferredLeader = candidates[0].device_id;
                  if (wall.leader_device_id !== preferredLeader) {
                    db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(preferredLeader, wall.id);
                    console.log(`Wall ${wall.id} leader reassigned to ${preferredLeader} on reconnect`);
                    // Re-push payload to every member so role flags refresh.
                    const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(wall.id);
                    for (const m of members) {
                      if (m.device_id !== device_id) {
                        commandQueue.queueOrEmitPlaylistUpdate(deviceNs, m.device_id, buildPlaylistPayload);
                      }
                    }
                  }
                }
              }
            } catch (e) { console.error('Wall leader reclaim failed:', e.message); }
          }

          // Check subscription/trial status before sending playlist
          const access = checkDeviceAccess(device_id);
          if (!access.allowed) {
            socket.emit('device:playlist-update', { assignments: [], suspended: true, message: access.message, detail: access.detail });
          } else {
            socket.emit('device:playlist-update', buildPlaylistPayload(device_id));
          }

          emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:device-status', { device_id, status: 'online' });
          // Only log a genuine reconnect (new socket). Same-socket periodic refreshes stay
          // quiet so the log reflects real connection events, not the 45s refresh cadence.
          if (!isPlaylistRefresh) logCoalescer.record('device-reconnected', `Device reconnected: ${device_id}`);
          return;
        }

        // Device ID not found in database - tell device to re-provision
        console.log(`Device ${device_id} not found in database, sending unpaired`);
        socket.emit('device:unpaired', { reason: 'not_found' });
        return;
      }

      if (pairing_code) {
        // New device registering with pairing code — generate a device_token
        const id = uuidv4();
        const newToken = generateDeviceToken();

        // #146 scale-hardening: a DB error on this INSERT must reject THIS device's
        // registration, never throw out of the handler. The likely error is a UNIQUE
        // pairing_code collision when many devices provision at once (client-supplied
        // 6-digit codes collide by birthday paradox), but ANY error counts. An
        // unhandled throw in a socket handler escalates to uncaughtException ->
        // logFatalAndExit -> the WHOLE server exits and every device drops — one
        // colliding code crash-looped the fleet in the load test. Catch it, log, and
        // tell just this device to retry. currentDeviceId/authenticated are set only
        // AFTER the row exists, so a failed insert leaves no half-authenticated socket.
        try {
          db.prepare(`
            INSERT INTO devices (id, pairing_code, device_token, status, ip_address, android_version, app_version, screen_width, screen_height, render_width, render_height, last_heartbeat)
            VALUES (?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
          `).run(
            id, pairing_code, newToken, getClientIp(socket),
            device_info?.android_version || null,
            device_info?.app_version || null,
            device_info?.screen_width || null,
            device_info?.screen_height || null,
            device_info?.render_width || null,
            device_info?.render_height || null
          );
        } catch (e) {
          console.warn(`Provisioning rejected for pairing_code ${pairing_code} from ${getClientIp(socket)}: ${e.message}`);
          socket.emit('device:auth-error', { error: 'Registration failed, please retry.' });
          return;
        }
        currentDeviceId = id;
        authenticated = true;

        heartbeat.registerConnection(id, socket.id);
        socket.join(id);
        socket.emit('device:registered', { device_id: id, device_token: newToken, status: 'provisioning' });

        // Newly-provisioned devices have no workspace_id yet (they'll get one
        // on pair claim). emitToDeviceWorkspace silently drops when there's no
        // workspace; that's safer than the previous platform-wide broadcast.
        // Dashboards refresh /api/devices/unassigned on poll for the
        // platform_admin pairing view.
        emitToDeviceWorkspace(dashboardNs, id, 'dashboard:device-added', db.prepare('SELECT * FROM devices WHERE id = ?').get(id));
        console.log(`New device registered: ${id} with pairing code: ${pairing_code}`);
      }
    });

    // Require authentication for all events after register
    function requireDeviceAuth() {
      if (!authenticated || !currentDeviceId) {
        socket.emit('device:auth-error', { error: 'Not authenticated. Send device:register first.' });
        return false;
      }
      return true;
    }

    // Heartbeat with telemetry
    socket.on('device:heartbeat', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, telemetry } = data;
      if (!device_id || device_id !== currentDeviceId) return;

      currentDeviceId = device_id;
      heartbeat.updateHeartbeat(device_id);

      db.prepare("UPDATE devices SET status = 'online', last_heartbeat = strftime('%s','now'), updated_at = strftime('%s','now') WHERE id = ?")
        .run(device_id);

      if (telemetry) {
        db.prepare(`
          INSERT INTO device_telemetry (device_id, battery_level, battery_charging, storage_free_mb, storage_total_mb,
            ram_free_mb, ram_total_mb, cpu_usage, wifi_ssid, wifi_rssi, uptime_seconds)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          device_id,
          telemetry.battery_level ?? null,
          telemetry.battery_charging ? 1 : 0,
          telemetry.storage_free_mb ?? null,
          telemetry.storage_total_mb ?? null,
          telemetry.ram_free_mb ?? null,
          telemetry.ram_total_mb ?? null,
          telemetry.cpu_usage ?? null,
          telemetry.wifi_ssid ?? null,
          telemetry.wifi_rssi ?? null,
          telemetry.uptime_seconds ?? null
        );
        pruneTelemetry(device_id);

        // #74/#75: capture the player's reported clock (OS IANA zone + its UTC time)
        // for effective-timezone resolution and the dashboard clock-skew indicator.
        if (telemetry.timezone || telemetry.device_utc != null) {
          db.prepare("UPDATE devices SET reported_timezone = COALESCE(?, reported_timezone), reported_utc = ?, reported_at = strftime('%s','now') WHERE id = ?")
            .run(telemetry.timezone || null, telemetry.device_utc ?? null, device_id);
        }

        emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:device-status', {
          device_id,
          status: 'online',
          telemetry
        });
      }
    });

    // Screenshot received from device - relay via WebSocket, keep latest in memory
    socket.on('device:screenshot', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, image_b64 } = data;
      if (!device_id || device_id !== currentDeviceId || !image_b64) return;
      // Validate screenshot size (max 2MB base64 ≈ 1.5MB image)
      if (image_b64.length > 2 * 1024 * 1024) return;

      // Store latest screenshot in memory (for Now Playing preview and offline snapshot)
      if (!lastScreenshots) lastScreenshots = {};
      lastScreenshots[device_id] = image_b64;

      // Relay directly to dashboard - no disk write
      try {
        emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:screenshot-ready', {
          device_id,
          image_data: `data:image/jpeg;base64,${image_b64}`,
          timestamp: Date.now()
        });
      } catch (err) {
        console.error('Screenshot save error:', err);
      }
    });

    // Content download acknowledgement
    socket.on('device:content-ack', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, content_id, status } = data;
      if (device_id !== currentDeviceId) return;
      // #142 dedup + #143 per-device rate budget + global critical-lag valve, in one
      // control. Anything but 'pass' is dropped BEFORE the log+emit (that per-ack work
      // is the cost we shed). Drops are SILENT except a single line per device per
      // window when rate-shedding STARTS (re-logging per drop would recreate the
      // flood). The valve's open/close is logged once at the band edge in loop-lag.
      const verdict = contentAckLimiter.check(device_id, content_id, status, loopLag.getBand());
      if (verdict.action !== 'pass') {
        if (verdict.action === 'shed-rate' && verdict.logStart) {
          console.warn(`[content-ack] shedding device ${device_id}: ${verdict.observed}/${verdict.budget} per ${config.contentAckRateWindowMs}ms — flood control engaged`);
        }
        return;
      }
      console.log(`Device ${device_id} content ${content_id}: ${status}`);
      emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:content-ack', { device_id, content_id, status });
    });

    // Playback state update
    socket.on('device:playback-state', (data) => {
      if (!requireDeviceAuth()) return;
      // currentDeviceId is the authenticated device for this socket; use it
      // for the workspace lookup since data may not carry device_id consistently.
      emitToDeviceWorkspace(dashboardNs, currentDeviceId, 'dashboard:playback-state', data);
    });

    // Live debug log line from the player (only sent when debug logging is toggled
    // on for this device). Relayed to the device's workspace dashboard room so the
    // open device-detail screen can stream it. Not persisted.
    socket.on('device:log', (data) => {
      if (!requireDeviceAuth() || !currentDeviceId) return;
      const message = typeof data?.message === 'string' ? data.message.slice(0, 2000) : '';
      if (!message) return;
      emitToDeviceWorkspace(dashboardNs, currentDeviceId, 'dashboard:device-log', {
        device_id: currentDeviceId,
        tag: typeof data?.tag === 'string' ? data.tag.slice(0, 64) : '',
        level: typeof data?.level === 'string' ? data.level.slice(0, 8) : 'd',
        message,
        ts: Date.now(),
      });
    });

    // #139 Phase 2 (Option B): event-driven OTA status. The device announces a status TRANSITION
    // ('manual_update_required' on enter-backoff, 'none' on clear) so the dashboard badge updates
    // promptly without waiting for a reconnect. The register path still persists these fields too
    // (the reconnect backstop if a transition event is missed). Same columns + ?? defaults.
    socket.on('device:ota-status', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, ota_status, ota_target_version, ota_attempts } = data || {};
      // Unknown / forged / mismatched id -> no-op. WHERE id = ? also makes an unregistered id a
      // 0-row update (never throws), so a stray event can't error the socket.
      if (!device_id || device_id !== currentDeviceId) return;
      db.prepare("UPDATE devices SET ota_status = ?, ota_target_version = ?, ota_attempts = ?, ota_updated_at = strftime('%s','now') WHERE id = ?")
        .run(ota_status ?? 'none', ota_target_version ?? null, ota_attempts ?? 0, device_id);
    });

    // Play event logging (proof-of-play)
    socket.on('device:play-event', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, event, content_id, content_name, zone_id, completed, duration_sec } = data;
      if (device_id !== currentDeviceId) return;
      try {
        if (event === 'play_start') {
          // Throttle proof-of-play inserts per device so a runaway player
          // (0-second items) can't flood play_logs. Skipped cycles simply
          // don't create a row; the dashboard progress event below still fires.
          const nowMs = Date.now();
          const lastMs = lastPlayLogAt.get(device_id) || 0;
          if (nowMs - lastMs >= PLAY_LOG_MIN_GAP_MS) {
            lastPlayLogAt.set(device_id, nowMs);
            db.prepare(`
              INSERT INTO play_logs (device_id, content_id, zone_id, content_name, started_at, trigger_type)
              VALUES (?, ?, ?, ?, strftime('%s','now'), 'playlist')
            `).run(device_id, content_id || null, zone_id || null, content_name || 'Unknown');
          }
          // Forward to dashboard so it can render a per-device progress bar.
          // Server-side timestamp avoids clock-skew between player and dashboard.
          emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:playback-progress', {
            device_id,
            content_id: content_id || null,
            content_name: content_name || null,
            duration_sec: typeof duration_sec === 'number' && duration_sec > 0 ? duration_sec : null,
            started_at: Date.now(),
          });
        } else if (event === 'play_end') {
          db.prepare(`
            UPDATE play_logs SET ended_at = strftime('%s','now'),
              duration_sec = strftime('%s','now') - started_at,
              completed = ?
            WHERE id = (
              SELECT id FROM play_logs WHERE device_id = ? AND content_id = ? AND ended_at IS NULL
              ORDER BY started_at DESC LIMIT 1
            )
          `).run(completed ? 1 : 0, device_id, content_id);
        }
      } catch (err) {
        console.error('Play log error:', err.message);
      }
    });

    // Video wall sync relay. Sender must be a member of the wall it claims —
    // otherwise an authenticated device could inject sync packets into a wall
    // it doesn't belong to (jitter/DoS that wall's playback). Exclusion uses
    // currentDeviceId, never the client-supplied data.device_id.
    socket.on('wall:sync', (data) => {
      if (!requireDeviceAuth()) return;
      if (!data?.wall_id) return;
      const isMember = db.prepare(
        'SELECT 1 FROM video_wall_devices WHERE wall_id = ? AND device_id = ?'
      ).get(data.wall_id, currentDeviceId);
      if (!isMember) return;
      const wallDevices = db.prepare(
        'SELECT device_id FROM video_wall_devices WHERE wall_id = ? AND device_id != ?'
      ).all(data.wall_id, currentDeviceId);
      // Stamp device_id with the authenticated id so followers can trust it.
      const payload = { ...data, device_id: currentDeviceId };
      for (const wd of wallDevices) {
        deviceNs.to(wd.device_id).emit('wall:sync', payload);
      }
    });

    // A follower asks for an immediate position update from the leader.
    // Used on (re)connect so the follower doesn't drift for ~1s waiting on
    // the next periodic wall:sync tick. Server forwards only to the leader,
    // and only when the requester is actually a member of the named wall.
    socket.on('wall:sync-request', (data) => {
      if (!requireDeviceAuth()) return;
      if (!data?.wall_id) return;
      const isMember = db.prepare(
        'SELECT 1 FROM video_wall_devices WHERE wall_id = ? AND device_id = ?'
      ).get(data.wall_id, currentDeviceId);
      if (!isMember) return;
      const wall = db.prepare('SELECT leader_device_id FROM video_walls WHERE id = ?').get(data.wall_id);
      if (!wall?.leader_device_id || wall.leader_device_id === currentDeviceId) return;
      deviceNs.to(wall.leader_device_id).emit('wall:sync-request', {
        wall_id: data.wall_id,
        requested_by: currentDeviceId,
      });
    });

    socket.on('disconnect', () => {
      // #146: this socket was force-evicted by a newer registration for the same
      // device. The new socket owns the device now (or is mid-register), so this
      // disconnect must NOT arm an offline timer — doing so was the self-reset race
      // that re-marked just-reconnected devices offline. The map-based stale guard
      // below can't catch it because eviction runs before the new socket is in the
      // map. Drain the flag and bail. (delete() returns true iff it was present.)
      if (evictedSockets.delete(socket.id)) return;

      if (!currentDeviceId) return;

      // Stale-disconnect guard: a newer socket already took over this device_id
      // via eviction. Skip the offline transition entirely - don't even start a
      // debounce timer.
      const activeConn = heartbeat.getConnection(currentDeviceId);
      if (activeConn && activeConn.socketId !== socket.id) {
        console.log(`Stale disconnect for ${currentDeviceId} (socket ${socket.id}); active is ${activeConn.socketId}, skipping offline`);
        return;
      }

      const deviceId = currentDeviceId;
      const closingSocketId = socket.id;
      console.log(`Device disconnected: ${deviceId} (offline transition deferred ${OFFLINE_DEBOUNCE_MS}ms)`);

      // Defensive: clear any existing timer for this device. Shouldn't happen
      // (register would have cleared it), but if two disconnects fire in
      // sequence we want the second to refresh the window, not double up.
      if (pendingOfflines.has(deviceId)) clearTimeout(pendingOfflines.get(deviceId));

      pendingOfflines.set(deviceId, setTimeout(() => {
        pendingOfflines.delete(deviceId);
        // Re-check at fire time: did a DIFFERENT socket reclaim during the
        // grace window? If activeConn exists but it's still our (now-closed)
        // socket's entry, the entry is just stale - heartbeat.removeConnection
        // hasn't run yet because we defer it inside this same block. Only
        // abort if a genuinely different socket has registered.
        const activeNow = heartbeat.getConnection(deviceId);
        if (activeNow && activeNow.socketId !== closingSocketId) return;

        db.prepare("UPDATE devices SET status = 'offline', updated_at = strftime('%s','now') WHERE id = ?").run(deviceId);
        heartbeat.removeConnection(deviceId);
        logDeviceStatus(deviceId, 'offline');
        emitToDeviceWorkspace(dashboardNs, deviceId, 'dashboard:device-status', { device_id: deviceId, status: 'offline' });

        // If this device was leading a wall, reassign leadership to the next
        // online member so playback stays driven.
        try {
          const wall = db.prepare('SELECT id FROM video_walls WHERE leader_device_id = ?').get(deviceId);
          if (wall) {
            const candidates = db.prepare(`
              SELECT vwd.device_id FROM video_wall_devices vwd
              JOIN devices d ON d.id = vwd.device_id
              WHERE vwd.wall_id = ? AND d.status = 'online' AND vwd.device_id != ?
              ORDER BY vwd.grid_row, vwd.grid_col LIMIT 1
            `).all(wall.id, deviceId);
            const newLeader = candidates[0]?.device_id || null;
            db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(newLeader, wall.id);
            const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(wall.id);
            for (const m of members) {
              if (m.device_id !== deviceId) {
                commandQueue.queueOrEmitPlaylistUpdate(deviceNs, m.device_id, buildPlaylistPayload);
              }
            }
          }
        } catch (e) { console.error('Wall leader reassign failed:', e.message); }

        // Save last screenshot to disk as offline snapshot
        const lastB64 = lastScreenshots[deviceId];
        if (lastB64) {
          try {
            const filename = `${deviceId}_latest.jpg`;
            const buffer = Buffer.from(lastB64, 'base64');
            fs.writeFileSync(path.join(config.screenshotsDir, filename), buffer);
            const existing = db.prepare('SELECT id FROM screenshots WHERE device_id = ?').get(deviceId);
            if (existing) {
              db.prepare('UPDATE screenshots SET filepath = ?, captured_at = strftime(\'%s\',\'now\') WHERE device_id = ?').run(filename, deviceId);
            } else {
              db.prepare('INSERT INTO screenshots (device_id, filepath) VALUES (?, ?)').run(deviceId, filename);
            }
          } catch (e) {
            console.error('Failed to save offline screenshot:', e.message);
          }
          delete lastScreenshots[deviceId];
        }
      }, OFFLINE_DEBOUNCE_MS));
    });
  });

  return deviceNs;
};

// #146 test hooks — read-only views of the internal offline-timer / eviction state,
// so the cause-1 re-arm race (evicted socket arming an offline timer for a
// just-reconnected device) is test-PROVEN, not just correct-by-construction. Prefixed
// `__` and never used by production code.
module.exports.__hasPendingOffline = (deviceId) => pendingOfflines.has(deviceId);
module.exports.__pendingOfflineCount = () => pendingOfflines.size;
module.exports.__evictedSize = () => evictedSockets.size;
module.exports.__resetTimers = () => {
  for (const t of pendingOfflines.values()) clearTimeout(t);
  pendingOfflines.clear();
  evictedSockets.clear();
};
