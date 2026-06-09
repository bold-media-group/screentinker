'use strict';

// Tests for the security quick-win fixes:
//  - stripDeviceSecrets() never leaks device_token
//  - publicBranding() exposes only presentational fields
//  - requireAuth enforces must_change_password server-side (#7)

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-security-fixes';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
    password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'free', email_alerts INTEGER DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0
  );
`);
const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db } };

const express = require('express');
const { generateToken, requireAuth } = require('../middleware/auth');
const { stripDeviceSecrets } = require('../lib/device-sanitize');
const { publicBranding } = require('../lib/branding');

test('stripDeviceSecrets removes device_token, keeps other fields', () => {
  const row = { id: 'd1', name: 'Lobby', device_token: 'SECRET', status: 'online' };
  const out = stripDeviceSecrets(row);
  assert.equal(out.device_token, undefined);
  assert.equal(out.name, 'Lobby');
  assert.equal(out.status, 'online');
  assert.equal(stripDeviceSecrets(null), null); // null-safe
});

test('publicBranding exposes only presentational fields (no internal columns)', () => {
  const dbRow = {
    id: 'wl1', user_id: 'u1', workspace_id: 'ws1', custom_domain: 'evil.example',
    created_at: 1, updated_at: 2,
    brand_name: 'Acme', logo_url: 'l', favicon_url: 'f', primary_color: '#000',
    secondary_color: '#111', bg_color: '#222', custom_css: 'body{}', hide_branding: 1,
  };
  const pub = publicBranding(dbRow);
  for (const leaked of ['id', 'user_id', 'workspace_id', 'custom_domain', 'created_at', 'updated_at']) {
    assert.equal(pub[leaked], undefined, `${leaked} must not be exposed`);
  }
  assert.equal(pub.brand_name, 'Acme');
  assert.equal(pub.custom_css, 'body{}'); // login page needs this
  assert.equal(pub.hide_branding, 1);
});

// --- #7: must_change_password enforced server-side ---
db.prepare("INSERT INTO users (id, email, role, must_change_password) VALUES ('u-mcp','mcp@test.local','user',1)").run();
db.prepare("INSERT INTO users (id, email, role, must_change_password) VALUES ('u-ok','ok@test.local','user',0)").run();
const tokMcp = generateToken({ id: 'u-mcp', email: 'mcp@test.local', role: 'user' }, null);
const tokOk = generateToken({ id: 'u-ok', email: 'ok@test.local', role: 'user' }, null);

const app = express();
// Mount requireAuth at the real prefixes so req.originalUrl matches the allowlist.
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ ok: true }));
app.get('/api/devices', requireAuth, (req, res) => res.json({ ok: true }));
const server = app.listen(0);
let base;
test.before(async () => { await new Promise(r => server.listening ? r() : server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); });

test('must_change_password user is blocked from non-/me routes (403) but can reach /me', async () => {
  const dev = await fetch(base + '/api/devices', { headers: { Authorization: `Bearer ${tokMcp}` } });
  assert.equal(dev.status, 403);
  assert.equal((await dev.json()).error, 'password_change_required');

  const me = await fetch(base + '/api/auth/me', { headers: { Authorization: `Bearer ${tokMcp}` } });
  assert.equal(me.status, 200, '/api/auth/me must stay reachable so the user can change their password');
});

test('a normal user (flag cleared) is not gated', async () => {
  const dev = await fetch(base + '/api/devices', { headers: { Authorization: `Bearer ${tokOk}` } });
  assert.equal(dev.status, 200);
});
