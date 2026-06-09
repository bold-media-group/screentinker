'use strict';

// Issue #18: DELETE /api/auth/users/:id failed with "FOREIGN KEY constraint
// failed". This suite reproduces the failure faithfully (foreign_keys ON,
// prod-like uncascaded FKs) and verifies the cascade/unlink/refuse behaviour.
//
// Isolated in-memory better-sqlite3 injected into the require cache (same
// harness as the other suites); Node v20 built-ins only.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-user-deletion';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
// Representative subset of the real schema with the SAME uncascaded FKs to
// users that caused #18. (The cascade helper's table-existence guard skips the
// tables we don't model here.)
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE organizations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    owner_user_id TEXT NOT NULL REFERENCES users(id)
  );
  CREATE TABLE organization_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invited_by TEXT REFERENCES users(id),
    role TEXT NOT NULL, UNIQUE(organization_id, user_id)
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL, created_by TEXT REFERENCES users(id)
  );
  CREATE TABLE workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invited_by TEXT REFERENCES users(id),
    role TEXT NOT NULL, UNIQUE(workspace_id, user_id)
  );
  CREATE TABLE workspace_invites (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT NOT NULL, role TEXT NOT NULL,
    invited_by TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
  );
  CREATE TABLE playlists (
    id TEXT PRIMARY KEY, name TEXT,
    user_id TEXT NOT NULL REFERENCES users(id),
    workspace_id TEXT REFERENCES workspaces(id)
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, name TEXT,
    user_id TEXT REFERENCES users(id),
    workspace_id TEXT REFERENCES workspaces(id)
  );
  CREATE TABLE content (
    id TEXT PRIMARY KEY, filename TEXT,
    user_id TEXT REFERENCES users(id),
    workspace_id TEXT REFERENCES workspaces(id)
  );
  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id),
    acting_user_id TEXT REFERENCES users(id),
    organization_id TEXT REFERENCES organizations(id),
    workspace_id TEXT REFERENCES workspaces(id),
    action TEXT NOT NULL, details TEXT, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
`);

const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = {
  id: dbModulePath, filename: dbModulePath, loaded: true,
  exports: { db, pruneTelemetry() {}, pruneScreenshots() {} },
};

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const authRouter = require('../routes/auth');

// ---- seed: an admin caller + a separate org owner ----
function user(id, role = 'user') {
  db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, ?, 'x')").run(id, id + '@test.local', role);
  return { id, email: id + '@test.local', role };
}
const admin = user('u-admin', 'platform_admin');
const regular = user('u-regular', 'user');           // non-superadmin caller
const orgOwner = user('u-owner', 'user');            // owns org X (the "other" tenant)
db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('orgX','Org X','u-owner')").run();
db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES ('orgX','u-owner','org_owner')").run();
db.prepare("INSERT INTO workspaces (id, organization_id, name, created_by) VALUES ('wsX','orgX','WS X','u-owner')").run();
db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('wsX','u-owner','workspace_admin')").run();

const tokens = { admin: generateToken(admin, null), regular: generateToken(regular, null) };

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
const server = app.listen(0);
let base;
test.before(async () => { await new Promise(r => server.listening ? r() : server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); });

const del = (id, token) => fetch(`${base}/api/auth/users/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
const exists = (table, id) => !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);

test('reproduces #18: a bare DELETE FROM users fails the FK constraint', () => {
  user('u-fkprobe');
  db.prepare("INSERT INTO playlists (id, user_id) VALUES ('p-fkprobe','u-fkprobe')").run();
  assert.throws(() => db.prepare('DELETE FROM users WHERE id = ?').run('u-fkprobe'), /FOREIGN KEY constraint failed/);
  db.prepare("DELETE FROM playlists WHERE id='p-fkprobe'").run();
  db.prepare("DELETE FROM users WHERE id='u-fkprobe'").run();
});

test('provisioned member (owns no org): deleted; resources preserved + unlinked', async () => {
  const t = user('u-member');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('wsX','u-member','workspace_editor')").run();
  db.prepare("INSERT INTO playlists (id, name, user_id, workspace_id) VALUES ('p1','P1','u-member','wsX')").run();
  db.prepare("INSERT INTO devices (id, name, user_id, workspace_id) VALUES ('d1','D1','u-member','wsX')").run();
  db.prepare("INSERT INTO activity_log (user_id, action) VALUES ('u-member','login')").run();

  const res = await del('u-member', tokens.admin);
  assert.equal(res.status, 200);
  assert.equal(exists('users', 'u-member'), false, 'user deleted');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM workspace_members WHERE user_id='u-member'").get().c, 0, 'membership cascaded');
  // org X untouched (not owned by the deleted user)
  assert.equal(exists('organizations', 'orgX'), true);
  assert.equal(exists('workspaces', 'wsX'), true);
  // playlist preserved, NOT NULL user_id reassigned to the workspace's org owner
  assert.equal(db.prepare("SELECT user_id FROM playlists WHERE id='p1'").get().user_id, 'u-owner', 'playlist reassigned to org owner');
  // device preserved, nullable user_id set null
  assert.equal(db.prepare("SELECT user_id FROM devices WHERE id='d1'").get().user_id, null, 'device unlinked');
  // activity preserved, user_id set null
  assert.equal(db.prepare("SELECT COUNT(*) c FROM activity_log WHERE user_id IS NULL").get().c >= 1, true, 'activity preserved, unlinked');
});

test('solo-org owner: org + workspace + contents hard-deleted with the user', async () => {
  user('u-solo');
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('orgS','Solo Org','u-solo')").run();
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES ('orgS','u-solo','org_owner')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name, created_by) VALUES ('wsS','orgS','WS S','u-solo')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('wsS','u-solo','workspace_admin')").run();
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id) VALUES ('pS','u-solo','wsS')").run();
  db.prepare("INSERT INTO devices (id, user_id, workspace_id) VALUES ('dS','u-solo','wsS')").run();
  db.prepare("INSERT INTO content (id, user_id, workspace_id) VALUES ('cS','u-solo','wsS')").run();

  const res = await del('u-solo', tokens.admin);
  assert.equal(res.status, 200);
  assert.equal(exists('users', 'u-solo'), false);
  assert.equal(exists('organizations', 'orgS'), false, 'owned org deleted');
  assert.equal(exists('workspaces', 'wsS'), false, 'workspace deleted');
  assert.equal(exists('playlists', 'pS'), false);
  assert.equal(exists('devices', 'dS'), false);
  assert.equal(exists('content', 'cS'), false);
});

test('shared-org owner: refused (409), nothing deleted', async () => {
  user('u-shared');
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('orgH','Shared Org','u-shared')").run();
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES ('orgH','u-shared','org_owner')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('wsH','orgH','WS H')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('wsH','u-shared','workspace_admin')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('wsH','u-owner','workspace_editor')").run(); // OTHER member

  const res = await del('u-shared', tokens.admin);
  assert.equal(res.status, 409);
  assert.equal(exists('users', 'u-shared'), true, 'not deleted');
  assert.equal(exists('organizations', 'orgH'), true, 'org intact');
});

test('cannot delete yourself (400) and non-superadmin denied (403)', async () => {
  const self = await del('u-admin', tokens.admin);
  assert.equal(self.status, 400);
  const denied = await del('u-owner', tokens.regular);
  assert.equal(denied.status, 403);
  assert.equal(exists('users', 'u-owner'), true);
});

test('missing user -> 404', async () => {
  const res = await del('does-not-exist', tokens.admin);
  assert.equal(res.status, 404);
});

// --- #36: deleteOrgCascade / deleteWorkspaceCascade (shared cascade helpers) ---
const { deleteOrgCascade, deleteWorkspaceCascade } = require('../lib/user-deletion');

test('deleteOrgCascade: org + all workspaces/resources/members gone; member users kept', () => {
  user('u-cust');
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('orgD','Cust','u-cust')").run();
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES ('orgD','u-cust','org_owner')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('wsD1','orgD','D1'),('wsD2','orgD','D2')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('wsD1','u-cust','workspace_admin')").run();
  db.prepare("INSERT INTO devices (id, workspace_id) VALUES ('dvD','wsD1')").run();
  db.prepare("INSERT INTO content (id, workspace_id) VALUES ('ctD','wsD2')").run();
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id) VALUES ('plD','u-cust','wsD1')").run();

  deleteOrgCascade(db, { orgId: 'orgD' });

  assert.equal(exists('organizations','orgD'), false, 'org gone');
  assert.equal(exists('workspaces','wsD1') || exists('workspaces','wsD2'), false, 'workspaces gone');
  assert.equal(exists('devices','dvD'), false, 'device gone');
  assert.equal(exists('content','ctD'), false, 'content gone');
  assert.equal(exists('playlists','plD'), false, 'playlist gone');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM organization_members WHERE organization_id='orgD'").get().c, 0, 'org members cascaded');
  assert.equal(exists('users','u-cust'), true, 'member user is NOT deleted');
});

test('deleteWorkspaceCascade: one workspace + resources gone; org + sibling intact', () => {
  user('u-cust2');
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('orgW','W','u-cust2')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES ('wsW1','orgW','W1'),('wsW2','orgW','W2')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('wsW1','u-cust2','workspace_admin')").run();
  db.prepare("INSERT INTO devices (id, workspace_id) VALUES ('dvW','wsW1'),('dvW2','wsW2')").run();

  deleteWorkspaceCascade(db, { workspaceId: 'wsW1' });

  assert.equal(exists('workspaces','wsW1'), false, 'target ws gone');
  assert.equal(exists('devices','dvW'), false, 'target ws device gone');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM workspace_members WHERE workspace_id='wsW1'").get().c, 0, 'members cascaded');
  assert.equal(exists('organizations','orgW'), true, 'org intact');
  assert.equal(exists('workspaces','wsW2'), true, 'sibling ws intact');
  assert.equal(exists('devices','dvW2'), true, 'sibling device intact');
});
