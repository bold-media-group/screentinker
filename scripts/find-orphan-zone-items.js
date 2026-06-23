#!/usr/bin/env node
/*
 * Report-only audit: find playlist_items whose zone_id is NOT a zone in the
 * device's ACTIVE layout — i.e. orphaned cross-layout assignments. Un-patched
 * players silently drop these; patched players (this branch) route them to the
 * largest zone and emit a "zone" device-log warning. This script only REPORTS;
 * it never mutates. Run it against a COPY of the prod DB.
 *
 *   node scripts/find-orphan-zone-items.js [path/to/remote_display.db]
 *
 * Exit code is always 0 (it's a report); the count is printed.
 */
const path = require('path');
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  // Resolve from the server's node_modules when run from the repo root.
  Database = require(path.join(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'));
}

const dbPath = process.argv[2] || path.join(__dirname, '..', 'server', 'db', 'remote_display.db');
const db = new Database(dbPath, { readonly: true });

// One row per (device, zoned item). A playlist shared by N devices is checked
// against EACH device's layout, since the same item can be valid for one device
// and orphaned for another.
const rows = db.prepare(`
  SELECT d.id   AS device_id,    d.name AS device_name,
         d.layout_id AS device_layout, dl.name AS device_layout_name,
         pi.id  AS item_id,      pi.zone_id,
         c.filename, c.mime_type,
         lz.layout_id AS zone_layout, zl.name AS zone_layout_name, lz.name AS zone_name
  FROM devices d
  JOIN playlist_items pi ON pi.playlist_id = d.playlist_id
  LEFT JOIN content c       ON c.id  = pi.content_id
  LEFT JOIN layout_zones lz ON lz.id = pi.zone_id
  LEFT JOIN layouts dl      ON dl.id = d.layout_id
  LEFT JOIN layouts zl      ON zl.id = lz.layout_id
  WHERE pi.zone_id IS NOT NULL
`).all();

// Orphan = the item's zone doesn't exist any more, OR it belongs to a different
// layout than the device is actually rendering.
const orphans = rows.filter(r => !r.zone_layout || r.zone_layout !== r.device_layout);

if (!orphans.length) {
  console.log(`No orphaned zone assignments found in ${dbPath}.`);
  db.close();
  process.exit(0);
}

console.log(`Found ${orphans.length} orphaned playlist_item(s) in ${dbPath}`);
console.log(`(zone_id references a zone that is NOT in the device's active layout):\n`);
for (const o of orphans) {
  const sid = s => (s || '').slice(0, 8);
  const where = o.zone_layout
    ? `zone "${o.zone_name}" lives in layout "${o.zone_layout_name}" (${sid(o.zone_layout)})`
    : `zone_id no longer exists`;
  console.log(`  device "${o.device_name}" (${sid(o.device_id)}) active layout "${o.device_layout_name || '—'}" (${sid(o.device_layout)})`);
  console.log(`    item #${o.item_id} ${o.filename || '?'} [${o.mime_type || '?'}] zone_id=${sid(o.zone_id)} -> ${where}`);
}
console.log(`\nReport only — nothing changed. Un-patched players drop these; patched players`);
console.log(`route them to the largest zone and log a "zone" warning. Use the hardening`);
console.log(`(remap-on-duplicate / validate-on-assign) to stop new ones being created.`);
db.close();
