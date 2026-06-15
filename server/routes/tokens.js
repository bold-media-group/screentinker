// Public API token management (Phase 1). DASHBOARD-ONLY: this router is mounted
// JWT-only in server.js, so an API token can never manage tokens (no privilege
// self-escalation). A user manages their own tokens, bound to their active workspace.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../db/database');
const { generateToken, hashToken, displayPrefix } = require('../middleware/apiToken');
const { accessContext } = require('../lib/tenancy');
const { isZonedPlaylist } = require('../lib/agency-targets'); // #73: full-screen-only guardrail

// #73: 'agency' is OFF the read/write/full ladder (not in apiToken.js SCOPE_RANK), so a
// tokenScopeGate-mounted router rejects it; it reaches only the AGENCY_ROUTER via agencyGate.
const SCOPES = ['read', 'write', 'full', 'agency'];

// List the caller's tokens in the active workspace. Never returns the secret/hash.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No active workspace' });
  const rows = db.prepare(`
    SELECT id, prefix, name, scope, auto_publish, workspace_id, created_at, last_used_at, revoked_at
    FROM api_tokens WHERE user_id = ? AND workspace_id = ? ORDER BY created_at DESC
  `).all(req.user.id, req.workspaceId);
  // #73: attach designated playlists for agency tokens so the admin sees the binding persist.
  const targetsStmt = db.prepare('SELECT p.id, p.name FROM api_token_targets t JOIN playlists p ON p.id = t.playlist_id WHERE t.token_id = ? ORDER BY p.name');
  for (const r of rows) {
    if (r.scope === 'agency') r.targets = targetsStmt.all(r.id);
  }
  res.json(rows);
});

// Create a token bound to the active workspace. The full secret is returned ONCE.
router.post('/', (req, res) => {
  if (!req.workspaceId || !req.workspace) return res.status(403).json({ error: 'No active workspace' });
  const name = (req.body.name || '').trim();
  const scope = req.body.scope || 'read';
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > 100) return res.status(400).json({ error: 'name too long' });
  if (!SCOPES.includes(scope)) return res.status(400).json({ error: "scope must be 'read', 'write', 'full' or 'agency'" });
  // The token runs with platform powers stripped (role forced to 'user'), so it must
  // bind to a workspace the owner reaches via membership/org - not platform act-as -
  // else apiTokenAuth+resolveTenancy would land it in no workspace at use time.
  if (!accessContext(req.user.id, 'user', req.workspace)) {
    return res.status(400).json({ error: 'You must be a member of this workspace to create a token here' });
  }
  // #73: an agency token is bound to a NON-EMPTY allowlist of playlists in THIS workspace.
  // Validate up front so a bad target never leaves an orphan token behind.
  let targetIds = [];
  // auto_publish is meaningful ONLY for agency scope and is the admin's explicit opt-OUT of
  // approval. Anything but agency-scope + literal true -> 0 (draft, the fail-safe default).
  const autoPublish = (scope === 'agency' && req.body.auto_publish === true) ? 1 : 0;
  if (scope === 'agency') {
    targetIds = Array.isArray(req.body.target_playlist_ids) ? req.body.target_playlist_ids : [];
    if (!targetIds.length) return res.status(400).json({ error: 'an agency token requires target_playlist_ids' });
    const inWs = db.prepare('SELECT id FROM playlists WHERE id = ? AND workspace_id = ?');
    for (const pid of targetIds) {
      if (!inWs.get(pid, req.workspaceId)) return res.status(400).json({ error: `playlist ${pid} is not in this workspace` });
      // #73: agencies get FULL-SCREEN playlists only - a zoned playlist can't take full-screen uploads.
      if (isZonedPlaylist(db, pid)) return res.status(400).json({ error: 'A selected playlist is assigned to a zone on a screen — agency uploads play full-screen, so it can\'t be shared with an agency. Use a full-screen playlist.' });
    }
  }
  const secret = generateToken();
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope, auto_publish, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
    `).run(id, hashToken(secret), displayPrefix(secret), name, req.user.id, req.workspaceId, scope, autoPublish);
    if (scope === 'agency') {
      const ins = db.prepare('INSERT INTO api_token_targets (token_id, playlist_id) VALUES (?, ?)');
      for (const pid of targetIds) ins.run(id, pid);
    }
  })();
  // `token` is returned only here, never again.
  res.status(201).json({ id, token: secret, prefix: displayPrefix(secret), name, scope, workspace_id: req.workspaceId, target_playlist_ids: targetIds, auto_publish: !!autoPublish });
});

// Revoke one of the caller's own tokens (soft delete - takes effect on the next request).
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT id, revoked_at FROM api_tokens WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Token not found' });
  if (!row.revoked_at) {
    db.prepare("UPDATE api_tokens SET revoked_at = strftime('%s','now') WHERE id = ?").run(req.params.id);
  }
  res.json({ success: true });
});

// #73: re-designate an agency token's playlist allowlist (atomic replace). JWT-only (this
// whole router is JWT-only), so an agency token can never widen its OWN targets.
router.put('/:id/targets', (req, res) => {
  const tok = db.prepare('SELECT id, scope, workspace_id FROM api_tokens WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!tok) return res.status(404).json({ error: 'Token not found' });
  if (tok.scope !== 'agency') return res.status(400).json({ error: 'only agency tokens have targets' });
  const ids = Array.isArray(req.body.target_playlist_ids) ? req.body.target_playlist_ids : [];
  if (!ids.length) return res.status(400).json({ error: 'target_playlist_ids must be a non-empty array' });
  const inWs = db.prepare('SELECT id FROM playlists WHERE id = ? AND workspace_id = ?');
  for (const pid of ids) {
    if (!inWs.get(pid, tok.workspace_id)) return res.status(400).json({ error: `playlist ${pid} is not in this token's workspace` });
    // #73: full-screen-only - a zoned playlist can't be (re-)designated to an agency.
    if (isZonedPlaylist(db, pid)) return res.status(400).json({ error: 'A selected playlist is assigned to a zone on a screen — agency uploads play full-screen, so it can\'t be shared with an agency. Use a full-screen playlist.' });
  }
  const ins = db.prepare('INSERT OR IGNORE INTO api_token_targets (token_id, playlist_id) VALUES (?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM api_token_targets WHERE token_id = ?').run(tok.id);
    for (const pid of ids) ins.run(tok.id, pid);
  })();
  res.json({ id: tok.id, target_playlist_ids: ids });
});

module.exports = router;
