'use strict';

// Issue #18 follow-up: workspace/org deletion hits the same FK wall the
// user-delete bug did - 13 tables reference workspaces(id) (and activity_log
// also organizations(id)) with NO ACTION. SQLite can't ALTER an FK action, so
// we rebuild each table (create-copy-rename, the pattern the assignments/
// schedules migrations already use) changing only the tenant FK clause:
//   workspace_id -> ON DELETE CASCADE   (resources belong to the workspace)
//   activity_log.workspace_id / organization_id -> ON DELETE SET NULL (keep audit)
// user_id FKs are intentionally left as-is (user delete is handled app-side by
// lib/user-deletion.js).
//
// Pure/testable: takes a better-sqlite3 db, records itself in schema_migrations,
// idempotent, and does NOT snapshot or exit (the boot caller in db/database.js
// owns the pre-migration snapshot + process.exit-on-failure).

const MIGRATION_ID = 'phase2_3_tenant_delete_cascade';

const WS_CASCADE_TABLES = [
  'devices', 'content', 'layouts', 'widgets', 'video_walls', 'device_groups',
  'alert_configs', 'white_labels', 'kiosk_pages', 'playlists', 'schedules', 'content_folders',
];

function fkOnDeleteAction(db, table, refTable) {
  const fk = db.prepare(`PRAGMA foreign_key_list(${table})`).all().find(f => f.table === refTable);
  return fk ? fk.on_delete : null;
}

// Rebuild `table`, changing the ON DELETE action of its FK(s) to the given ref
// table(s). Preserves every column/constraint by transforming the stored CREATE
// text and copying rows verbatim; recreates the table's (non-auto) indexes.
function rebuildTableFkActions(db, table, actions, opts = {}) {
  const tmp = `${table}_fkmig_new`;
  let sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
  for (const [ref, action] of Object.entries(actions)) {
    const re = new RegExp(`REFERENCES\\s+${ref}\\s*\\(\\s*id\\s*\\)(?!\\s+ON\\s+DELETE)`, 'gi');
    sql = sql.replace(re, (m) => `${m} ON DELETE ${action}`);
  }
  // Rename only the leading `CREATE TABLE [IF NOT EXISTS] ["]table["]` token.
  sql = sql.replace(new RegExp(`^CREATE TABLE\\s+(IF NOT EXISTS\\s+)?("?)${table}\\2`, 'i'), `CREATE TABLE "${tmp}"`);

  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table).map(r => r.sql);
  db.exec(sql);
  db.exec(`INSERT INTO "${tmp}" SELECT * FROM "${table}"`);
  db.exec(`DROP TABLE "${table}"`);
  db.exec(`ALTER TABLE "${tmp}" RENAME TO "${table}"`);
  for (const idx of indexes) db.exec(idx);
  // Keep AUTOINCREMENT high-water marks monotonic across the rename (activity_log).
  if (opts.autoincrement) {
    db.exec(`DELETE FROM sqlite_sequence WHERE name IN ('${table}', '${tmp}')`);
    db.exec(`INSERT INTO sqlite_sequence(name, seq) VALUES ('${table}', (SELECT COALESCE(MAX(rowid),0) FROM "${table}"))`);
  }
}

// Returns { status: 'already' | 'no-workspaces' | 'applied', tables?: [...] }.
// Throws (after ROLLBACK) if a rebuild fails; the caller restores from snapshot.
function applyTenantDeleteCascade(db) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID)) return { status: 'already' };

  const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  if (!have.has('workspaces')) {
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);
    return { status: 'no-workspaces' };
  }
  // Idempotency: devices.workspace_id already cascading => treat as applied.
  if (have.has('devices') && fkOnDeleteAction(db, 'devices', 'workspaces') === 'CASCADE') {
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);
    return { status: 'already' };
  }

  const baselineViolations = db.prepare('PRAGMA foreign_key_check').all().length;
  const rebuilt = [];

  // foreign_keys must be toggled OUTSIDE a transaction in SQLite.
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    for (const t of WS_CASCADE_TABLES) {
      if (!have.has(t)) continue;                                       // partial schema / older DB
      if (fkOnDeleteAction(db, t, 'workspaces') === 'CASCADE') continue; // partial re-run safety
      rebuildTableFkActions(db, t, { workspaces: 'CASCADE' });
      rebuilt.push(t);
    }
    if (have.has('activity_log') && fkOnDeleteAction(db, 'activity_log', 'workspaces') !== 'SET NULL') {
      rebuildTableFkActions(db, 'activity_log', { workspaces: 'SET NULL', organizations: 'SET NULL' }, { autoincrement: true });
      rebuilt.push('activity_log');
    }
    // Rows are copied verbatim, so a rebuild cannot introduce NEW violations;
    // abort only if the count grew (catches a botched CREATE transform).
    const after = db.prepare('PRAGMA foreign_key_check').all().length;
    if (after > baselineViolations) throw new Error(`foreign_key_check violations increased ${baselineViolations} -> ${after}`);
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return { status: 'applied', tables: rebuilt };
}

module.exports = { applyTenantDeleteCascade, MIGRATION_ID, WS_CASCADE_TABLES };
