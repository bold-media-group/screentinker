'use strict';

// Issue #15: instance-level default white-label branding.
//
// Branding is stored per-workspace in white_labels (keyed by workspace_id). This
// adds a single "platform default" row that every workspace inherits unless it
// has set its own. Resolution order:
//   1. the current workspace's row        (per-workspace override; unchanged)
//   2. a custom-domain match              (public/pre-login white-label hosts)
//   3. the platform-default row           (instance default, #15)
//   4. hardcoded ScreenTinker fallback
//
// The platform-default row is identified by a FIXED id (not "workspace_id IS
// NULL"): legacy pre-multitenancy white_labels rows can also have a null
// workspace_id, so a null-scope sentinel would be ambiguous. A fixed id is not.
//
// Override is ROW-LEVEL: a workspace that has any row uses it wholesale; only
// workspaces with NO row fall through to the platform default. No row-copying at
// creation, so editing the platform default propagates everywhere instantly.

const PLATFORM_DEFAULT_ID = 'platform-default';

const HARDCODED_BRANDING = {
  brand_name: 'ScreenTinker',
  logo_url: null,
  favicon_url: null,
  primary_color: '#3B82F6',
  secondary_color: '#1E293B',
  bg_color: '#111827',
  custom_css: null,
  hide_branding: 0,
};

// The single platform-default row (fixed id), or null if none has been set.
function platformDefaultRow(db) {
  return db.prepare('SELECT * FROM white_labels WHERE id = ?').get(PLATFORM_DEFAULT_ID) || null;
}

// Resolve effective branding for a context. Pass whichever you have:
//   { workspaceId } for the authed app, { domain } for the public/login path.
function resolveBranding(db, { workspaceId = null, domain = null } = {}) {
  if (workspaceId) {
    const wl = db.prepare('SELECT * FROM white_labels WHERE workspace_id = ?').get(workspaceId);
    if (wl) return wl;
  }
  if (domain) {
    const wl = db.prepare('SELECT * FROM white_labels WHERE custom_domain = ?').get(domain);
    if (wl) return wl;
  }
  return platformDefaultRow(db) || { ...HARDCODED_BRANDING };
}

module.exports = { resolveBranding, platformDefaultRow, HARDCODED_BRANDING, PLATFORM_DEFAULT_ID };
