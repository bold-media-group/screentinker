const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { OAuth2Client } = require('google-auth-library');
const { db } = require('../db/database');
const { generateToken, requireAuth, requireAdmin, requireSuperAdmin, PLATFORM_ROLES } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const { logActivity, getClientIp } = require('../services/activity');
const config = require('../config');

// Phase 2.1: find or create the user's default org+workspace. Returns the
// workspace_id to embed in the JWT. Idempotent: if the user already has
// memberships (e.g. migrated from Phase 1), returns the first one without
// creating anything.
function ensureDefaultOrgForUser(user) {
  const existing = db.prepare(`
    SELECT w.id FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ?
    ORDER BY wm.joined_at ASC LIMIT 1
  `).get(user.id);
  if (existing) return existing.id;

  // No memberships -> mint a fresh org and Default workspace owned by user.
  const orgId = uuidv4();
  const wsId  = uuidv4();
  const orgName = (user.name && user.name.trim())
    ? `${user.name}'s organization`
    : `${user.email}'s organization`;
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO organizations (
      id, name, owner_user_id, plan_id,
      stripe_customer_id, stripe_subscription_id,
      subscription_status, subscription_ends
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      orgId, orgName, user.id, user.plan_id || 'free',
      user.stripe_customer_id || null, user.stripe_subscription_id || null,
      user.subscription_status || 'active', user.subscription_ends || null
    );
    db.prepare(`INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')`).run(orgId, user.id);
    db.prepare(`INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, 'Default', ?)`).run(wsId, orgId, user.id);
    db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')`).run(wsId, user.id);
  });
  tx();
  return wsId;
}

function logFailedLogin(email, ip, reason) {
  try {
    db.prepare('INSERT INTO activity_log (user_id, action, details, ip_address) VALUES (NULL, ?, ?, ?)')
      .run('auth:login_failed', `${email} - ${reason}`, ip);
  } catch {}
}

function logSuccessfulLogin(userId, email, ip) {
  try {
    // Phase 2.2 writer-leak fix: stamp the user's oldest workspace so this
    // login event is queryable in tenant-scoped activity views. Multi-workspace
    // users still land on one row; the activity dashboard already shows
    // per-user context separately from per-workspace context.
    const ws = db.prepare(
      'SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY joined_at ASC LIMIT 1'
    ).get(userId);
    db.prepare('INSERT INTO activity_log (user_id, action, details, ip_address, workspace_id) VALUES (?, ?, ?, ?, ?)')
      .run(userId, 'auth:login_success', email, ip, ws?.workspace_id || null);
    db.prepare("UPDATE users SET last_login = strftime('%s','now') WHERE id = ?").run(userId);
  } catch {}
}

// ==================== Local Auth ====================

// Returns true if new account creation is allowed at this moment.
// First-user setup (empty DB) is always allowed so a fresh install can be initialized.
function canRegister() {
  if (!config.disableRegistration) return true;
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  return userCount === 0;
}

// Register
router.post('/register', (req, res) => {
  if (!canRegister()) {
    return res.status(403).json({ error: 'Public registration is disabled. Contact your administrator.' });
  }
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 10);

  // First user becomes platform_admin with enterprise plan (self-hosted) or free plan with Pro trial.
  // Phase 1 renamed the legacy 'superadmin' role to 'platform_admin'; new bootstrap users get the new name directly.
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const role = userCount === 0 ? 'platform_admin' : 'user';
  const isFirstUser = userCount === 0;
  const plan = (isFirstUser && config.selfHosted) ? 'enterprise' : 'pro'; // Start on Pro trial
  const trialStarted = isFirstUser && config.selfHosted ? null : Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id, trial_started, trial_plan)
    VALUES (?, ?, ?, ?, 'local', ?, ?, ?, ?)
  `).run(id, email.toLowerCase(), name || email.split('@')[0], passwordHash, role, plan, trialStarted, trialStarted ? 'pro' : null);

  const user = db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_ends FROM users WHERE id = ?').get(id);
  const workspaceId = ensureDefaultOrgForUser(user);
  const token = generateToken(user, workspaceId);

  res.status(201).json({ token, user, current_workspace_id: workspaceId });
});

// Login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND auth_provider = ?').get(email.toLowerCase(), 'local');
  if (!user) {
    logFailedLogin(email, getClientIp(req), 'User not found');
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    logFailedLogin(email, getClientIp(req), 'Wrong password');
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  logSuccessfulLogin(user.id, email, getClientIp(req));
  const workspaceId = ensureDefaultOrgForUser(user);
  const token = generateToken(user, workspaceId);
  const { password_hash, ...safeUser } = user;
  res.json({ token, user: safeUser, current_workspace_id: workspaceId });
});

// ==================== Google OAuth ====================

router.post('/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Google credential required' });

  try {
    // Verify the Google ID token
    const payload = await verifyGoogleToken(credential);
    if (!payload) return res.status(401).json({ error: 'Invalid Google token' });

    const { email, name, picture, sub: googleId } = payload;

    // Find or create user
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());

    if (!user) {
      if (!canRegister()) {
        return res.status(403).json({ error: 'Public registration is disabled. Contact your administrator.' });
      }
      const id = uuidv4();
      const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
      const role = userCount === 0 ? 'platform_admin' : 'user';
      const isFirst = userCount === 0;
      const plan = (isFirst && config.selfHosted) ? 'enterprise' : 'pro';
      const trialStarted = isFirst && config.selfHosted ? null : Math.floor(Date.now() / 1000);

      db.prepare(`
        INSERT INTO users (id, email, name, auth_provider, provider_id, avatar_url, role, plan_id, trial_started, trial_plan)
        VALUES (?, ?, ?, 'google', ?, ?, ?, ?, ?, ?)
      `).run(id, email.toLowerCase(), name || '', googleId, picture || '', role, plan, trialStarted, trialStarted ? 'pro' : null);

      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    } else if (user.auth_provider !== 'google') {
      // Existing account with different provider — do NOT silently overwrite auth_provider.
      // If they have a local password, require them to log in locally and link from settings.
      if (user.password_hash) {
        return res.status(409).json({ error: 'An account with this email already exists. Please log in with your password.' });
      }
      // No password (e.g. Microsoft → Google switch) — allow linking
      db.prepare('UPDATE users SET auth_provider = ?, provider_id = ?, avatar_url = ? WHERE id = ?')
        .run('google', googleId, picture || user.avatar_url, user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }

    const workspaceId = ensureDefaultOrgForUser(user);
    const token = generateToken(user, workspaceId);
    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser, current_workspace_id: workspaceId });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(401).json({ error: 'Google authentication failed' });
  }
});

async function verifyGoogleToken(credential) {
  const client = new OAuth2Client(config.googleClientId);
  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: config.googleClientId || undefined,
    });
    return ticket.getPayload();
  } catch (e) {
    // Fallback: if credential is an access token, verify via tokeninfo
    try {
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${credential}`);
      if (!res.ok) throw new Error('Invalid token');
      return await res.json();
    } catch {
      throw new Error('Google token verification failed: ' + e.message);
    }
  }
}

// ==================== Microsoft OAuth ====================

router.post('/microsoft', async (req, res) => {
  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: 'Microsoft access token required' });

  try {
    // Use the access token to get user profile from Microsoft Graph
    const profile = await getMicrosoftProfile(access_token);
    if (!profile || !profile.mail && !profile.userPrincipalName) {
      return res.status(401).json({ error: 'Could not get Microsoft profile' });
    }

    const email = (profile.mail || profile.userPrincipalName).toLowerCase();
    const name = profile.displayName || '';
    const microsoftId = profile.id;

    // Find or create user
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user) {
      if (!canRegister()) {
        return res.status(403).json({ error: 'Public registration is disabled. Contact your administrator.' });
      }
      const id = uuidv4();
      const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
      const role = userCount === 0 ? 'platform_admin' : 'user';
      const isFirst = userCount === 0;
      const plan = (isFirst && config.selfHosted) ? 'enterprise' : 'pro';
      const trialStarted = isFirst && config.selfHosted ? null : Math.floor(Date.now() / 1000);

      db.prepare(`
        INSERT INTO users (id, email, name, auth_provider, provider_id, role, plan_id, trial_started, trial_plan)
        VALUES (?, ?, ?, 'microsoft', ?, ?, ?, ?, ?)
      `).run(id, email, name, microsoftId, role, plan, trialStarted, trialStarted ? 'pro' : null);

      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    } else if (user.auth_provider !== 'microsoft') {
      // Existing account with different provider — do NOT silently overwrite auth_provider.
      if (user.password_hash) {
        return res.status(409).json({ error: 'An account with this email already exists. Please log in with your password.' });
      }
      db.prepare('UPDATE users SET auth_provider = ?, provider_id = ? WHERE id = ?')
        .run('microsoft', microsoftId, user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }

    const workspaceId = ensureDefaultOrgForUser(user);
    const token = generateToken(user, workspaceId);
    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser, current_workspace_id: workspaceId });
  } catch (err) {
    console.error('Microsoft auth error:', err);
    res.status(401).json({ error: 'Microsoft authentication failed' });
  }
});

function getMicrosoftProfile(accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'graph.microsoft.com',
      path: '/v1.0/me',
      headers: { Authorization: `Bearer ${accessToken}` }
    };
    https.get(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ==================== User Management ====================

// Get current user + tenancy context.
// Phase 2.1: response shape extended with current_workspace, current_organization,
// roles, and the list of accessible workspaces. Legacy fields (user object at
// the top level) are preserved so existing frontend code continues to work.
router.get('/me', requireAuth, resolveTenancy, (req, res) => {
  const accessible = db.prepare(`
    SELECT w.id, w.name, w.organization_id, o.name AS organization_name, wm.role AS workspace_role
    FROM workspace_members wm
    JOIN workspaces w ON w.id = wm.workspace_id
    JOIN organizations o ON o.id = w.organization_id
    WHERE wm.user_id = ?
    ORDER BY o.name, w.name
  `).all(req.user.id);

  const currentOrg = req.organizationId
    ? db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(req.organizationId)
    : null;

  res.json({
    ...req.user,
    current_workspace_id: req.workspaceId,
    current_workspace: req.workspace ? { id: req.workspace.id, name: req.workspace.name, organization_id: req.workspace.organization_id } : null,
    current_organization: currentOrg,
    current_workspace_role: req.workspaceRole,
    current_org_role: req.orgRole,
    is_platform_admin: req.isPlatformAdmin,
    acting_as: req.actingAs,
    accessible_workspaces: accessible,
  });
});

// Switch the active workspace. Validates the user has access (direct
// workspace_member, org-level admin in the parent org, or platform_admin),
// then mints a fresh JWT with the new current_workspace_id.
router.post('/switch-workspace', requireAuth, (req, res) => {
  const { workspace_id } = req.body || {};
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspace_id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  const isPlatformAdmin = req.user.role === 'platform_admin' || req.user.role === 'superadmin';
  const wsMember = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(ws.id, req.user.id);
  const orgMember = db.prepare(`
    SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?
  `).get(ws.organization_id, req.user.id);
  const canAct = isPlatformAdmin
    || !!wsMember
    || (orgMember && (orgMember.role === 'org_owner' || orgMember.role === 'org_admin'));

  if (!canAct) return res.status(403).json({ error: 'Access denied to that workspace' });

  const token = generateToken(req.user, ws.id);
  res.json({ token, current_workspace_id: ws.id });
});

// Update current user
router.put('/me', requireAuth, (req, res) => {
  const { name, password, current_password } = req.body;
  if (name) {
    db.prepare('UPDATE users SET name = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?')
      .run(name, req.user.id);
  }
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const row = db.prepare('SELECT password_hash, auth_provider FROM users WHERE id = ?').get(req.user.id);
    if (!row) return res.status(404).json({ error: 'User not found' });
    if (row.auth_provider !== 'local') {
      return res.status(400).json({ error: `Your account signs in via ${row.auth_provider}. Manage your password there.` });
    }
    if (row.password_hash) {
      if (!current_password || !bcrypt.compareSync(current_password, row.password_hash)) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
    }
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?')
      .run(hash, req.user.id);
  }
  const user = db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

// List users - platform admins see all, admins see team members only
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  if (PLATFORM_ROLES.includes(req.user.role)) {
    const users = db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id, created_at, last_login FROM users ORDER BY created_at ASC').all();
    res.json(users);
  } else {
    // Admin sees themselves + users in their teams
    const users = db.prepare(`
      SELECT DISTINCT u.id, u.email, u.name, u.role, u.auth_provider, u.avatar_url, u.plan_id, u.created_at
      FROM users u
      LEFT JOIN team_members tm ON u.id = tm.user_id
      WHERE u.id = ? OR tm.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)
      ORDER BY u.created_at ASC
    `).all(req.user.id, req.user.id);
    res.json(users);
  }
});

// Delete user (superadmin only)
router.delete('/users/:id', requireAuth, requireSuperAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Update user role (superadmin only)
router.put('/users/:id/role', requireAuth, requireSuperAdmin, (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin', 'superadmin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (req.params.id === req.user.id && role !== 'superadmin') return res.status(400).json({ error: 'Cannot demote yourself' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.json({ success: true });
});

// Admin password reset for another user.
// Superadmins: can reset any local user. Admins: can reset members of teams
// they own (and never a superadmin). Self-reset routes through PUT /me with
// current_password — this endpoint is the override path.
router.put('/users/:id/password', requireAuth, requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Use Settings > Change Password for your own account' });
  }
  const target = db.prepare('SELECT id, email, role, auth_provider FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.auth_provider !== 'local') {
    return res.status(400).json({ error: `User signs in via ${target.auth_provider} — password reset does not apply` });
  }

  if (!PLATFORM_ROLES.includes(req.user.role)) {
    // Admin path: must own a team that includes the target, and target must
    // be a regular user (cannot reset another admin's or a platform_admin's
    // password — that would be a lateral-takeover vector).
    if (target.role !== 'user') {
      return res.status(403).json({ error: 'Admins can only reset passwords for regular users' });
    }
    const sharedOwnedTeam = db.prepare(`
      SELECT 1 FROM team_members tm_admin
      JOIN team_members tm_target ON tm_admin.team_id = tm_target.team_id
      WHERE tm_admin.user_id = ? AND tm_admin.role = 'owner'
        AND tm_target.user_id = ?
      LIMIT 1
    `).get(req.user.id, req.params.id);
    if (!sharedOwnedTeam) {
      return res.status(403).json({ error: 'You can only reset passwords for members of teams you own' });
    }
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(hash, req.params.id);

  // Explicit audit entry — the generic activity logger captures the route
  // and target id, but a labeled detail string makes the audit log readable.
  // Never include the password; just who reset whose password.
  logActivity(req.user.id, 'password_reset_for_user', `target: ${target.email}`, null, getClientIp(req));
  res.json({ success: true });
});

// Get auth config (public - tells frontend which providers are available)
router.get('/config', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  res.json({
    googleEnabled: !!config.googleClientId,
    googleClientId: config.googleClientId,
    microsoftEnabled: !!config.microsoftClientId,
    microsoftClientId: config.microsoftClientId,
    microsoftTenantId: config.microsoftTenantId,
    localEnabled: true,
    needsSetup: userCount === 0,
    registration_enabled: !config.disableRegistration || userCount === 0,
  });
});

module.exports = router;
