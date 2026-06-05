// Phase 2.1: permission helpers.
//
// Routes call these as Express middleware to gate access, or as predicate
// functions to branch within a handler. They presume resolveTenancy has
// already attached req.workspaceId / req.workspaceRole / req.orgRole /
// req.isPlatformAdmin.
//
// Layering (top wins):
//   1. req.isPlatformAdmin -> allow anything
//   2. req.orgRole in {org_owner, org_admin} -> allow read/write/admin within the org
//      org_owner also has billing.write and org.delete (not exposed in 2.1)
//   3. req.workspaceRole in {workspace_admin, workspace_editor, workspace_viewer}
//      gates resource access per the role's bands

'use strict';

const { isPlatformRole, isPlatformStaff } = require('../middleware/auth');

// #13: platform staff (admin OR operator) get cross-org read/write. canRead and
// canWrite include req.isPlatformStaff; canAdmin deliberately does NOT - it stays
// owner-gated, so operators can read/write resources everywhere but cannot
// perform workspace-admin actions (member mgmt, rename, branding, etc.).
function canRead(req) {
  if (req.isPlatformStaff) return true;
  if (req.orgRole === 'org_owner' || req.orgRole === 'org_admin') return true;
  return !!req.workspaceRole; // any workspace_member can read
}

function canWrite(req) {
  if (req.isPlatformStaff) return true;
  if (req.orgRole === 'org_owner' || req.orgRole === 'org_admin') return true;
  return req.workspaceRole === 'workspace_admin' || req.workspaceRole === 'workspace_editor';
}

function canAdmin(req) {
  if (req.isPlatformAdmin) return true; // owner only - NOT platform_operator
  if (req.orgRole === 'org_owner' || req.orgRole === 'org_admin') return true;
  return req.workspaceRole === 'workspace_admin';
}

function isOrgAdmin(req) {
  if (req.isPlatformAdmin) return true;
  return req.orgRole === 'org_owner' || req.orgRole === 'org_admin';
}

function isOrgOwner(req) {
  if (req.isPlatformAdmin) return true;
  return req.orgRole === 'org_owner';
}

// ---- middleware variants ----

function requireWorkspace(req, res, next) {
  if (!req.workspaceId) {
    return res.status(403).json({ error: 'No workspace context' });
  }
  next();
}

function requireWorkspaceRead(req, res, next) {
  if (!canRead(req)) {
    return res.status(403).json({ error: 'Workspace access required' });
  }
  next();
}

function requireWorkspaceWrite(req, res, next) {
  if (!canWrite(req)) {
    return res.status(403).json({ error: 'Workspace editor or admin required' });
  }
  next();
}

function requireWorkspaceAdmin(req, res, next) {
  if (!canAdmin(req)) {
    return res.status(403).json({ error: 'Workspace admin required' });
  }
  next();
}

function requireOrgAdmin(req, res, next) {
  if (!isOrgAdmin(req)) {
    return res.status(403).json({ error: 'Organization admin required' });
  }
  next();
}

function requireOrgOwner(req, res, next) {
  if (!isOrgOwner(req)) {
    return res.status(403).json({ error: 'Organization owner required' });
  }
  next();
}

// #14: the dead/stricter requirePlatformAdmin that used to live here (bare
// `=== 'platform_admin'`, excluding legacy superadmin) was removed. The single
// platform-admin guard is requirePlatformAdmin in server/middleware/auth.js,
// which is the alias every route already imports and which accepts the full
// PLATFORM_ROLES set via isPlatformRole().

// Decoupled "can admin this workspace" predicate. Unlike canAdmin(req) above,
// this takes an explicit (user, workspace) pair instead of reading from req,
// so it works for routes that operate on a target workspace specified by URL
// param (rename, future settings/delete) rather than the caller's currently
// active one. Does its own DB lookups against workspace_members + organization_members.
function canAdminWorkspace(db, user, workspace) {
  if (!user || !workspace) return false;
  // Owner only (isPlatformRole) - platform_operator is intentionally excluded,
  // so operators cannot manage workspace members, rename, or set branding (#13).
  if (isPlatformRole(user.role)) return true;
  const om = db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?')
    .get(workspace.organization_id, user.id);
  if (om && (om.role === 'org_owner' || om.role === 'org_admin')) return true;
  const wm = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspace.id, user.id);
  return wm && wm.role === 'workspace_admin';
}

// Read-access companion to canAdminWorkspace. Same (user, workspace) shape but
// accepts any workspace_members role (admin/editor/viewer) in addition to the
// org / platform paths. Used by GET endpoints on a URL-param target workspace
// where resolveTenancy is not on the request (e.g. /api/workspaces/:id/members).
function canAccessWorkspace(db, user, workspace) {
  if (!user || !workspace) return false;
  // Read access: platform staff (admin OR operator) can view any workspace,
  // including its member list (#13, read-only - mutations stay owner-gated via
  // canAdminWorkspace).
  if (isPlatformStaff(user.role)) return true;
  const om = db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?')
    .get(workspace.organization_id, user.id);
  if (om && (om.role === 'org_owner' || om.role === 'org_admin')) return true;
  const wm = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspace.id, user.id);
  return !!wm;
}

module.exports = {
  // boolean predicates
  canRead, canWrite, canAdmin, canAdminWorkspace, canAccessWorkspace, isOrgAdmin, isOrgOwner,
  // express middleware
  requireWorkspace,
  requireWorkspaceRead,
  requireWorkspaceWrite,
  requireWorkspaceAdmin,
  requireOrgAdmin,
  requireOrgOwner,
};
