const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { canAdminWorkspace } = require('../lib/permissions');
const { logActivity, getClientIp } = require('../services/activity');

// Admin-provisioned user creation (#10). Operates on a target workspace
// specified in the body, NOT the caller's active workspace - so this router is
// mounted with requireAuth only (no resolveTenancy), mirroring routes/workspaces.js.
// Permission is gated per-handler via canAdminWorkspace() against the TARGET
// workspace, which:
//   - lets a platform_admin create users anywhere,
//   - scopes an org_admin / org_owner to workspaces in orgs they administer,
//   - and excludes platform_operator (isPlatformRole owner-only) - operators
//     have no user/role-management power (#13).

// Same email shape the invite-create endpoint validates against (workspaces.js).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WORKSPACE_ROLES = ['workspace_admin', 'workspace_editor', 'workspace_viewer'];
// Mirror the server-side minimum enforced by PUT /api/auth/me and register.
const MIN_PASSWORD_LENGTH = 8;

// POST /api/admin/users - create a user with an admin-set password and assign
// them to a workspace + role. The result is indistinguishable from an
// invite-accepted user (a global users row + a workspace_members row).
router.post('/users', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '');
  // Accept workspaceId (preferred) or orgId as an alias for the target field.
  const workspaceId = String(req.body?.workspaceId || req.body?.orgId || '').trim();
  const role = String(req.body?.role || '').trim();
  const mustChangePassword = !!req.body?.mustChangePassword;

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (!WORKSPACE_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Role must be workspace_admin, workspace_editor, or workspace_viewer' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId required' });
  }

  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  if (!canAdminWorkspace(db, req.user, ws)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  // Stamp the target workspace so the activityLogger middleware (and our
  // explicit audit row) attribute to the right tenant.
  req.workspaceId = ws.id;

  // Email uniqueness: clean 409, never overwrite an existing account.
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'A user with that email already exists' });
  }

  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 10);

  // HOSTED_INSTANCE: an admin-provisioned user is already set up with a
  // password, so they must NOT receive the welcome email or enter the
  // activation-nudge lifecycle. We never call sendSignupEmails here, and the
  // nudge sweep already excludes them (they have a workspace_members row); we
  // additionally stamp both *_sent_at sentinels so any future sweep treats them
  // as already-handled. See services/signupEmails.js + services/activationNudge.js.
  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO users (
        id, email, name, password_hash, auth_provider, role, plan_id,
        must_change_password, welcome_email_sent_at, activation_nudge_sent_at
      ) VALUES (?, ?, ?, ?, 'local', 'user', 'free', ?, strftime('%s','now'), strftime('%s','now'))
    `).run(id, email, name || email.split('@')[0], passwordHash, mustChangePassword ? 1 : 0);

    // Same membership footprint as an accepted invite: one workspace_members
    // row, invited_by = the admin who created them.
    db.prepare(`
      INSERT INTO workspace_members (workspace_id, user_id, role, invited_by)
      VALUES (?, ?, ?, ?)
    `).run(ws.id, id, role, req.user.id);
  });
  txn();

  // Explicit audit row - who created whom, where, with what role. Never the
  // plaintext password (and the generic activityLogger only summarizes name).
  logActivity(req.user.id, 'admin_create_user', `target: ${email}, role: ${role}`, null, getClientIp(req), ws.id);

  // Response never includes password or hash.
  const created = db.prepare(
    'SELECT id, email, name, role, auth_provider, plan_id, must_change_password, created_at FROM users WHERE id = ?'
  ).get(id);
  res.status(201).json({ ...created, workspace_id: ws.id, workspace_role: role });
});

module.exports = router;
