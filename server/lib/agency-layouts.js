'use strict';

// #73: layout GEOMETRY for an agency token's designated playlists. DEVICE-FREE BY
// CONSTRUCTION: the only path used is playlist_items.zone_id -> layout_zones -> layouts.
// It never references devices / device_groups / schedules, so no fleet data (device names,
// locations, IPs, screen sizes, topology) can leak - it's structurally absent, not filtered.
// Confined to THIS token's designated playlists (t.token_id) in its bound workspace.
// Returns layout canvas size + ALL zones' geometry (no zone CONTENT) + which zones this
// token feeds. Bite-tested in test/agency-layouts.test.js.
function listLayoutGeometry(db, tokenId, workspaceId, playlistId = null) {
  // Distinct layouts that this token's designated playlists feed (via their items' zones).
  // Optional playlistId narrows to ONE designated playlist (the per-playlist card).
  const layouts = db.prepare(`
    SELECT DISTINCT l.id, l.name, l.width, l.height
    FROM api_token_targets t
    JOIN playlists p       ON p.id = t.playlist_id AND p.workspace_id = ?
    JOIN playlist_items pi ON pi.playlist_id = p.id AND pi.zone_id IS NOT NULL
    JOIN layout_zones lz   ON lz.id = pi.zone_id
    JOIN layouts l         ON l.id = lz.layout_id
    WHERE t.token_id = ?${playlistId ? ' AND p.id = ?' : ''}
    ORDER BY l.name
  `).all(...(playlistId ? [workspaceId, tokenId, playlistId] : [workspaceId, tokenId]));

  // All zones of a layout - GEOMETRY ONLY (no content, no device data lives here anyway).
  const zonesStmt = db.prepare(`
    SELECT id, name, x_percent, y_percent, width_percent, height_percent,
           z_index, zone_type, fit_mode, background_color, sort_order
    FROM layout_zones WHERE layout_id = ? ORDER BY sort_order, z_index
  `);
  // Which zones of a given layout THIS token actually feeds.
  const feedsStmt = db.prepare(`
    SELECT DISTINCT pi.zone_id
    FROM api_token_targets t
    JOIN playlist_items pi ON pi.playlist_id = t.playlist_id AND pi.zone_id IS NOT NULL
    JOIN layout_zones lz   ON lz.id = pi.zone_id
    WHERE t.token_id = ? AND lz.layout_id = ?
  `);

  return layouts.map(l => ({
    id: l.id,
    name: l.name,
    width: l.width,
    height: l.height,
    zones: zonesStmt.all(l.id),
    feeds_zone_ids: feedsStmt.all(tokenId, l.id).map(r => r.zone_id),
  }));
}

module.exports = { listLayoutGeometry };
