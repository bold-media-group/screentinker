'use strict';

// #146 BILLING — owner-only minting of a `billing:read` scoped token. The logic lives here
// (testable); scripts/mint-billing-token.js is a thin CLI wrapper. Reuses the EXACT existing
// token shape — same secret format (st_ + 32 random bytes base64url), same SHA-256 hashing,
// same api_tokens columns — so a minted token verifies through the normal apiTokenAuth path.
//
// NOTE ON HASHING: the codebase hashes token secrets with SHA-256 (middleware/apiToken.js
// hashToken), NOT bcrypt, and stores a single `scope` TEXT column (not a JSON `scopes`
// array). We reuse that exact path rather than introduce a second token format.
//
// NOTE ON BINDING: api_tokens.user_id and workspace_id are BOTH NOT NULL — there is no
// platform-level (workspace-less) token today. A `billing:read` token's workspace binding
// is VESTIGIAL: the scope is off the read/write/full ladder, so tokenScopeGate/agencyGate
// reject it on every workspace router; it authorizes ONLY GET /api/billing/usage, which is
// platform-global and ignores the binding. Rather than loosen that NOT NULL for every token
// type right before release, we bind to the platform OWNER + their workspace and record why.

const crypto = require('crypto');
const { generateToken, hashToken, displayPrefix } = require('../middleware/apiToken');

const BILLING_SCOPE = 'billing:read';

// The platform OWNER = highest-privilege user. #14 collapsed superadmin → platform_admin,
// so PLATFORM_ROLES is the top tier; there is no finer "owner" tier. Oldest such user wins.
function resolveOwner(db) {
  return db.prepare(
    "SELECT id, email FROM users WHERE role IN ('platform_admin','superadmin') ORDER BY created_at ASC, rowid ASC LIMIT 1"
  ).get();
}

// A workspace to satisfy the NOT NULL FK — the owner's first workspace (as tenancy resolves
// it), else any workspace. Vestigial for billing (see header).
function resolveWorkspaceId(db, ownerId) {
  const own = db.prepare(
    'SELECT wm.workspace_id AS id FROM workspace_members wm WHERE wm.user_id = ? ORDER BY wm.joined_at ASC LIMIT 1'
  ).get(ownerId);
  if (own) return own.id;
  const any = db.prepare('SELECT id FROM workspaces ORDER BY rowid ASC LIMIT 1').get();
  return any ? any.id : null;
}

// Mint a billing:read token. Returns { id, secret, prefix, name, scope, owner_id,
// workspace_id }. The secret is plaintext and returned ONCE — the caller must surface it and
// never store it. Throws if no owner/workspace exists.
function mintBillingToken(db, { name } = {}) {
  const label = (name || '').trim();
  if (!label) throw new Error('a token --name is required');
  if (label.length > 100) throw new Error('name too long (max 100)');

  const owner = resolveOwner(db);
  if (!owner) throw new Error('no platform-admin/owner user exists — create one before minting a billing token');
  const workspaceId = resolveWorkspaceId(db, owner.id);
  if (!workspaceId) throw new Error('no workspace exists to satisfy the api_tokens FK');

  const secret = generateToken();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
  `).run(id, hashToken(secret), displayPrefix(secret), label, owner.id, workspaceId, BILLING_SCOPE);

  return { id, secret, prefix: displayPrefix(secret), name: label, scope: BILLING_SCOPE, owner_id: owner.id, owner_email: owner.email, workspace_id: workspaceId };
}

// Soft-revoke (mirrors routes/tokens.js DELETE): sets revoked_at; apiTokenAuth refuses on
// the next request. Only revokes billing:read tokens (a safety rail for the CLI).
function revokeBillingToken(db, id) {
  const row = db.prepare('SELECT id, scope, revoked_at FROM api_tokens WHERE id = ?').get(id);
  if (!row) return { ok: false, reason: 'not found' };
  if (row.scope !== BILLING_SCOPE) return { ok: false, reason: `token ${id} has scope '${row.scope}', not ${BILLING_SCOPE} — refuse (use the dashboard to revoke workspace tokens)` };
  if (row.revoked_at) return { ok: true, alreadyRevoked: true };
  db.prepare("UPDATE api_tokens SET revoked_at = strftime('%s','now') WHERE id = ?").run(id);
  return { ok: true };
}

function listBillingTokens(db) {
  return db.prepare(
    'SELECT id, prefix, name, created_at, last_used_at, revoked_at FROM api_tokens WHERE scope = ? ORDER BY created_at DESC'
  ).all(BILLING_SCOPE);
}

module.exports = { mintBillingToken, revokeBillingToken, listBillingTokens, BILLING_SCOPE };
