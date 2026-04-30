const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

// Visibility model (matches widgets/users):
//   superadmin: all walls
//   admin:      own + walls owned by members of teams this admin owns
//   user:       own only
function listVisibleWalls(user) {
  if (user.role === 'superadmin') {
    return db.prepare('SELECT * FROM video_walls ORDER BY created_at DESC').all();
  }
  if (user.role === 'admin') {
    return db.prepare(`
      SELECT DISTINCT w.* FROM video_walls w
      LEFT JOIN team_members tm_target ON w.user_id = tm_target.user_id
      LEFT JOIN team_members tm_admin
             ON tm_admin.team_id = tm_target.team_id
            AND tm_admin.user_id = ?
            AND tm_admin.role = 'owner'
      WHERE w.user_id = ?
         OR tm_admin.team_id IS NOT NULL
      ORDER BY w.created_at DESC
    `).all(user.id, user.id);
  }
  return db.prepare('SELECT * FROM video_walls WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
}

function userCanAccessWall(user, wall) {
  if (user.role === 'superadmin') return true;
  if (wall.user_id === user.id) return true;
  if (user.role === 'admin') {
    const ownsTeamWithOwner = db.prepare(`
      SELECT 1 FROM team_members tm_target
      JOIN team_members tm_admin ON tm_admin.team_id = tm_target.team_id
      WHERE tm_target.user_id = ? AND tm_admin.user_id = ? AND tm_admin.role = 'owner'
      LIMIT 1
    `).get(wall.user_id, user.id);
    if (ownsTeamWithOwner) return true;
  }
  return false;
}

// List walls (with attached devices)
router.get('/', (req, res) => {
  const walls = listVisibleWalls(req.user);

  const devStmt = db.prepare(`
    SELECT vwd.*, d.name as device_name, d.status as device_status
    FROM video_wall_devices vwd
    JOIN devices d ON vwd.device_id = d.id
    WHERE vwd.wall_id = ?
    ORDER BY vwd.grid_row, vwd.grid_col
  `);
  walls.forEach(w => { w.devices = devStmt.all(w.id); });

  res.json(walls);
});

function checkWallAccess(req, res) {
  const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(req.params.id);
  if (!wall) { res.status(404).json({ error: 'Wall not found' }); return null; }
  if (!userCanAccessWall(req.user, wall)) {
    res.status(403).json({ error: 'Access denied' }); return null;
  }
  return wall;
}

// Notify dashboard clients to re-fetch walls/devices. Re-fetches re-apply
// per-user visibility filtering, so a broadcast is safe.
function notifyDashboards(req) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    io.of('/dashboard').emit('dashboard:wall-changed');
  } catch (e) { /* silent */ }
}

function loadWallWithDevices(id) {
  const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(id);
  if (!wall) return null;
  wall.devices = db.prepare(`
    SELECT vwd.*, d.name as device_name, d.status as device_status
    FROM video_wall_devices vwd JOIN devices d ON vwd.device_id = d.id
    WHERE vwd.wall_id = ? ORDER BY vwd.grid_row, vwd.grid_col
  `).all(id);
  return wall;
}

// Push a fresh wall-aware playlist payload to one device.
function pushWallPayloadToDevice(req, deviceId) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    io.of('/device').to(deviceId).emit('device:playlist-update', buildPlaylistPayload(deviceId));
  } catch (e) { /* silent */ }
}

function pushToWallMembers(req, wallId) {
  const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(wallId);
  for (const m of members) pushWallPayloadToDevice(req, m.device_id);
}

// Get wall with devices
router.get('/:id', (req, res) => {
  const wall = checkWallAccess(req, res);
  if (!wall) return;
  res.json(loadWallWithDevices(wall.id));
});

// Create wall
router.post('/', (req, res) => {
  const { name, grid_cols, grid_rows, bezel_h_mm, bezel_v_mm, playlist_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO video_walls (id, user_id, name, grid_cols, grid_rows, bezel_h_mm, bezel_v_mm, playlist_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, name, grid_cols || 2, grid_rows || 1,
    bezel_h_mm || 0, bezel_v_mm || 0, playlist_id || null);

  const wall = loadWallWithDevices(id);
  notifyDashboards(req);
  res.status(201).json(wall);
});

// Update wall (name, grid, bezels, playlist, leader, sync_mode)
router.put('/:id', (req, res) => {
  const wall = checkWallAccess(req, res);
  if (!wall) return;

  const fields = ['name', 'grid_cols', 'grid_rows', 'bezel_h_mm', 'bezel_v_mm',
    'screen_w_mm', 'screen_h_mm', 'sync_mode', 'leader_device_id', 'content_id', 'playlist_id',
    'player_x', 'player_y', 'player_width', 'player_height'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.id);
    db.prepare(`UPDATE video_walls SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  // If playlist changed, propagate to every member device's playlist_id so the
  // existing buildPlaylistPayload picks up the right items.
  if (req.body.playlist_id !== undefined) {
    const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(req.params.id);
    const stmt = db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?');
    for (const m of members) stmt.run(req.body.playlist_id || null, m.device_id);
  }

  pushToWallMembers(req, req.params.id);
  notifyDashboards(req);
  res.json(loadWallWithDevices(req.params.id));
});

// Delete wall — clear playlists + wall_id on every former member (matches
// group-dissolve semantics: leaving the wall returns devices to ungrouped).
router.delete('/:id', (req, res) => {
  const wall = checkWallAccess(req, res);
  if (!wall) return;

  const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(req.params.id);
  const tx = db.transaction(() => {
    db.prepare("UPDATE devices SET wall_id = NULL, playlist_id = NULL WHERE wall_id = ?").run(req.params.id);
    db.prepare('DELETE FROM video_walls WHERE id = ?').run(req.params.id);
  });
  tx();

  // Push fresh (now wall-less, playlist-less) payloads to ex-members so they
  // exit wall mode and clear content immediately.
  for (const m of members) pushWallPayloadToDevice(req, m.device_id);
  notifyDashboards(req);

  res.json({ success: true });
});

// Set device grid positions. Replaces the entire member set.
// Devices removed lose their playlist (returned to ungrouped); devices added
// inherit the wall's playlist.
router.put('/:id/devices', (req, res) => {
  const { devices } = req.body;
  if (!Array.isArray(devices)) return res.status(400).json({ error: 'devices array required' });

  const wall = checkWallAccess(req, res);
  if (!wall) return;

  // Verify caller owns (or has team access to) every device they're adding.
  // Without this a user could attach another tenant's devices to their own
  // wall and silently take over the playlist + wall_id on those rows.
  // Mirrors the per-device check in device-groups.js.
  if (!['superadmin'].includes(req.user.role)) {
    const isAdmin = req.user.role === 'admin';
    for (const d of devices) {
      const dev = db.prepare('SELECT user_id, team_id FROM devices WHERE id = ?').get(d.device_id);
      if (!dev) return res.status(404).json({ error: `Device ${d.device_id} not found` });
      if (dev.user_id === req.user.id) continue;
      if (isAdmin && dev.user_id) {
        // Admin may attach team members' devices: dev's owner must be in a team this admin owns
        const ownsTeamWithOwner = db.prepare(`
          SELECT 1 FROM team_members tm_target
          JOIN team_members tm_admin ON tm_admin.team_id = tm_target.team_id
          WHERE tm_target.user_id = ? AND tm_admin.user_id = ? AND tm_admin.role = 'owner'
          LIMIT 1
        `).get(dev.user_id, req.user.id);
        if (ownsTeamWithOwner) continue;
      }
      // Non-admin: must own the device directly
      return res.status(403).json({ error: `Access denied to device ${d.device_id}` });
    }
  }

  const previous = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(req.params.id);
  const previousIds = new Set(previous.map(p => p.device_id));
  const incomingIds = new Set(devices.map(d => d.device_id));
  const removedIds = [...previousIds].filter(id => !incomingIds.has(id));

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM video_wall_devices WHERE wall_id = ?').run(req.params.id);
    db.prepare("UPDATE devices SET wall_id = NULL WHERE wall_id = ?").run(req.params.id);

    // Removed devices: clear playlist (they're returning to ungrouped state).
    for (const id of removedIds) {
      db.prepare("UPDATE devices SET playlist_id = NULL WHERE id = ?").run(id);
    }

    const insertPos = db.prepare(`
      INSERT INTO video_wall_devices
        (wall_id, device_id, grid_col, grid_row, rotation, canvas_x, canvas_y, canvas_width, canvas_height)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateDevice = db.prepare("UPDATE devices SET wall_id = ?, playlist_id = ? WHERE id = ?");

    for (const d of devices) {
      insertPos.run(
        req.params.id, d.device_id,
        d.grid_col, d.grid_row, d.rotation || 0,
        d.canvas_x ?? null, d.canvas_y ?? null,
        d.canvas_width ?? null, d.canvas_height ?? null,
      );
      updateDevice.run(req.params.id, wall.playlist_id || null, d.device_id);
      // A device joining a wall leaves all of its groups (walls and groups
      // are mutually exclusive concepts in this UX).
      db.prepare('DELETE FROM device_group_members WHERE device_id = ?').run(d.device_id);
    }

    if (devices.length > 0) {
      // Prefer the device whose canvas rect is closest to the wall's top-left
      // (smallest canvas_x + canvas_y), falling back to grid 0,0, then first.
      const leader =
        [...devices].sort((a, b) => ((a.canvas_x ?? 0) + (a.canvas_y ?? 0)) - ((b.canvas_x ?? 0) + (b.canvas_y ?? 0)))[0]
        || devices.find(d => d.grid_col === 0 && d.grid_row === 0)
        || devices[0];
      db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(leader.device_id, req.params.id);
    } else {
      db.prepare('UPDATE video_walls SET leader_device_id = NULL WHERE id = ?').run(req.params.id);
    }
  });
  tx();

  // Push wall-aware payload to current members, and a wall-less payload to
  // ex-members so they exit wall mode.
  for (const id of removedIds) pushWallPayloadToDevice(req, id);
  pushToWallMembers(req, req.params.id);
  notifyDashboards(req);

  res.json(loadWallWithDevices(req.params.id));
});

// Set wall content (legacy single-video path — kept for back-compat)
router.put('/:id/content', (req, res) => {
  const wall = checkWallAccess(req, res);
  if (!wall) return;
  const { content_id } = req.body;
  db.prepare("UPDATE video_walls SET content_id = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(content_id || null, req.params.id);
  res.json({ success: true });
});

// Get wall config for a specific device (legacy fetch path)
router.get('/:id/device-config/:deviceId', (req, res) => {
  const wall = checkWallAccess(req, res);
  if (!wall) return;

  const position = db.prepare('SELECT * FROM video_wall_devices WHERE wall_id = ? AND device_id = ?')
    .get(req.params.id, req.params.deviceId);
  if (!position) return res.status(404).json({ error: 'Device not in this wall' });

  res.json({
    wall_id: wall.id,
    grid_cols: wall.grid_cols,
    grid_rows: wall.grid_rows,
    grid_col: position.grid_col,
    grid_row: position.grid_row,
    rotation: position.rotation,
    bezel_h_px: wall.bezel_h_mm,
    bezel_v_px: wall.bezel_v_mm,
    sync_mode: wall.sync_mode,
    is_leader: wall.leader_device_id === req.params.deviceId,
  });
});

module.exports = router;
