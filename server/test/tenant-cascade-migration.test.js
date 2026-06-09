'use strict';

// Issue #18 follow-up: workspace/org deletion must cascade to tenant resources.
// This suite reproduces the FK wall (workspace_id NO ACTION), applies the
// migration, and verifies the rebuilt FKs cascade (and activity_log SET NULLs to
// preserve audit). Pure-function migration tested against an in-memory DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { applyTenantDeleteCascade } = require('../lib/tenant-cascade-migration');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Prod-shaped subset: workspace_id FKs are NO ACTION, like the bug. Includes
  // CASCADE child tables (telemetry, playlist_items) to prove deep cascade and a
  // workspace index to prove index recreation. activity_log is AUTOINCREMENT.
  db.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER DEFAULT (strftime('%s','now')));
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, name TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, workspace_id TEXT REFERENCES workspaces(id));
    CREATE TABLE device_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT REFERENCES devices(id) ON DELETE CASCADE, val TEXT);
    CREATE TABLE content (id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id));
    CREATE TABLE playlists (id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id));
    CREATE INDEX idx_playlists_workspace ON playlists(workspace_id);
    CREATE TABLE playlist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE);
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT,
      workspace_id TEXT REFERENCES workspaces(id), organization_id TEXT REFERENCES organizations(id));
  `);
  db.exec(`
    INSERT INTO organizations (id,name) VALUES ('o1','Org 1');
    INSERT INTO workspaces (id,organization_id,name) VALUES ('w1','o1','WS1'),('w2','o1','WS2');
    INSERT INTO devices (id,workspace_id) VALUES ('d1','w1');
    INSERT INTO device_telemetry (device_id,val) VALUES ('d1','x');
    INSERT INTO content (id,workspace_id) VALUES ('c1','w1');
    INSERT INTO playlists (id,workspace_id) VALUES ('p1','w1'),('p2','w2');
    INSERT INTO playlist_items (playlist_id) VALUES ('p1');
    INSERT INTO activity_log (action,workspace_id,organization_id) VALUES ('event','w1','o1');
  `);
  return db;
}
const onDelete = (db, t, ref) => (db.prepare(`PRAGMA foreign_key_list(${t})`).all().find(f => f.table === ref) || {}).on_delete;

test('reproduces the gap: deleting a workspace fails the FK before migration', () => {
  const db = freshDb();
  assert.throws(() => db.prepare("DELETE FROM workspaces WHERE id='w1'").run(), /FOREIGN KEY constraint failed/);
  db.close();
});

test('migration rewrites the FK actions (CASCADE for tenant tables, SET NULL for activity_log) and keeps indexes', () => {
  const db = freshDb();
  const res = applyTenantDeleteCascade(db);
  assert.equal(res.status, 'applied');
  for (const t of ['devices', 'content', 'playlists']) assert.equal(onDelete(db, t, 'workspaces'), 'CASCADE', `${t}.workspace_id`);
  assert.equal(onDelete(db, 'activity_log', 'workspaces'), 'SET NULL');
  assert.equal(onDelete(db, 'activity_log', 'organizations'), 'SET NULL');
  // index recreated, data intact, foreign_keys restored to ON
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_playlists_workspace'").get(), 'index preserved');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM playlists').get().c, 2, 'rows preserved');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign_keys ON again');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'no FK violations');
  db.close();
});

test('after migration: deleting a workspace cascades resources + children; activity_log preserved (SET NULL)', () => {
  const db = freshDb();
  applyTenantDeleteCascade(db);
  db.prepare("DELETE FROM workspaces WHERE id='w1'").run();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM devices WHERE workspace_id='w1'").get().c, 0, 'devices gone');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM device_telemetry").get().c, 0, 'telemetry cascaded via device');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM content WHERE workspace_id='w1'").get().c, 0, 'content gone');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM playlists WHERE workspace_id='w1'").get().c, 0, 'playlists gone');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM playlist_items").get().c, 0, 'playlist_items cascaded');
  // activity_log row survives, unlinked from the deleted workspace
  const a = db.prepare("SELECT workspace_id, organization_id FROM activity_log WHERE action='event'").get();
  assert.equal(a.workspace_id, null, 'activity workspace_id SET NULL');
  assert.equal(a.organization_id, 'o1', 'org link intact (org not deleted)');
  db.close();
});

test('after migration: deleting an organization cascades through its workspaces', () => {
  const db = freshDb();
  applyTenantDeleteCascade(db);
  db.prepare("DELETE FROM organizations WHERE id='o1'").run();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM workspaces').get().c, 0, 'workspaces cascaded');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM playlists').get().c, 0, 'tenant resources cascaded');
  assert.equal(db.prepare("SELECT organization_id FROM activity_log WHERE action='event'").get().organization_id, null, 'activity org SET NULL');
  db.close();
});

test('idempotent: a second run is a no-op', () => {
  const db = freshDb();
  assert.equal(applyTenantDeleteCascade(db).status, 'applied');
  assert.equal(applyTenantDeleteCascade(db).status, 'already');
  db.close();
});
