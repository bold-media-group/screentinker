// Workspace members view - read-only listing of direct workspace_members,
// org-level access entries (via_org flag), and pending invites. Slice 2A
// (read-only only). Slice 2B will add the invite modal + role-change +
// remove buttons; slice 2C will add the accept-invite URL handler.

import { api } from '../api.js';
import { t } from '../i18n.js';

export async function render(container, workspaceId) {
  container.innerHTML = `
    <div class="page-header">
      <h1>${t('members.title')}</h1>
    </div>
    <div id="workspaceMembersContent" style="color:var(--text-muted)">${t('members.loading')}</div>
  `;
  const content = document.getElementById('workspaceMembersContent');

  let members;
  try {
    members = await api.getWorkspaceMembers(workspaceId);
  } catch (err) {
    const msg = err.message || '';
    // /members is gated by canAccessWorkspace; server returns 403 with
    // "Workspace access required" or 404 with "Workspace not found". Either
    // one is the same UX from the caller's perspective: they cannot view
    // this workspace.
    if (/Workspace access required|Workspace not found/.test(msg)) {
      content.innerHTML = renderError(t('members.workspace_not_found'));
    } else {
      content.innerHTML = renderError(t('members.load_error', { error: esc(msg) }));
    }
    return;
  }

  // /invites is admin-only. Non-admin members will get 403; that's expected -
  // suppress the section silently rather than surfacing an "error" they can't
  // act on. Other failures also suppress (logged to console for debugging).
  let invites = null;
  try {
    invites = await api.getWorkspaceInvites(workspaceId);
  } catch (err) {
    console.warn('getWorkspaceInvites failed (expected for non-admins):', err.message);
    invites = null;
  }

  const direct = members.filter(m => !m.via_org);
  const viaOrg = members.filter(m => m.via_org);

  content.innerHTML = `
    ${renderSection({
      titleKey: 'members.section.direct',
      count: direct.length,
      emptyKey: 'members.empty.members',
      rows: direct.map(m => renderMemberRow(m, { showJoined: true })).join(''),
    })}
    ${viaOrg.length > 0 ? renderSection({
      titleKey: 'members.section.via_org',
      count: viaOrg.length,
      emptyKey: null,
      rows: viaOrg.map(m => renderMemberRow(m, { showJoined: false, viaOrg: true })).join(''),
    }) : ''}
    ${invites !== null ? renderSection({
      titleKey: 'members.section.pending',
      count: invites.length,
      emptyKey: 'members.empty.invites',
      rows: invites.map(renderInviteRow).join(''),
    }) : ''}
  `;
}

function renderSection({ titleKey, count, emptyKey, rows }) {
  const countLabel = count > 0
    ? `<span style="color:var(--text-muted);font-weight:400;font-size:13px"> (${count})</span>`
    : '';
  const body = (count === 0 && emptyKey)
    ? `<p style="color:var(--text-muted);font-size:13px">${t(emptyKey)}</p>`
    : `<div class="members-list">${rows}</div>`;
  return `
    <div class="settings-section" style="margin-bottom:24px">
      <h3 style="font-size:15px;margin-bottom:12px">${t(titleKey)}${countLabel}</h3>
      ${body}
    </div>
  `;
}

function renderMemberRow(m, opts = {}) {
  const { showJoined = false, viaOrg = false } = opts;
  const initial = ((m.name || m.email || '?')[0] || '?').toUpperCase();
  const rightCell = viaOrg
    ? `<span class="member-via-org">${t('members.via_org_label')}</span>`
    : (showJoined ? esc(formatDate(m.joined_at)) : '');
  return `
    <div class="member-row${viaOrg ? ' member-row--via-org' : ''}">
      <div class="member-avatar">${esc(initial)}</div>
      <div class="member-meta">
        <div class="member-name">${esc(m.name || m.email)}</div>
        <div class="member-email">${esc(m.email)}</div>
      </div>
      <div class="member-role">${esc(t('members.role.' + m.role))}</div>
      <div class="member-detail">${rightCell}</div>
    </div>
  `;
}

function renderInviteRow(inv) {
  const initial = ((inv.email || '?')[0] || '?').toUpperCase();
  const invitedBy = inv.invited_by_email
    ? t('members.invited_by', { email: inv.invited_by_email })
    : '';
  const expires = t('members.expires_in', { when: formatDate(inv.expires_at) });
  return `
    <div class="member-row member-row--invited">
      <div class="member-avatar member-avatar--muted">${esc(initial)}</div>
      <div class="member-meta">
        <div class="member-name">
          ${esc(inv.email)}
          <span class="member-badge">${t('members.invited_label')}</span>
        </div>
        <div class="member-email">${esc(invitedBy)}</div>
      </div>
      <div class="member-role">${esc(t('members.role.' + inv.role))}</div>
      <div class="member-detail">${esc(expires)}</div>
    </div>
  `;
}

function renderError(message) {
  return `<div style="color:var(--danger);font-size:14px;padding:16px;background:var(--bg-input);border-radius:6px">${message}</div>`;
}

// Unix-seconds -> locale-aware short date. Mirrors the playlists.js inline
// helper; not extracting to utils.js until a third caller appears.
function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
