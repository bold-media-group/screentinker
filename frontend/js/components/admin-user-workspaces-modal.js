// "Manage workspaces" modal for the platform Users admin page. Lets a platform
// admin see/manage ALL of a user's workspace memberships: list each with an
// inline role dropdown + Remove, and add the user to more workspaces via a
// type-to-filter picker. Backed by /api/admin/users/:id/workspaces.
import { api } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from '../components/toast.js';

// Display order = least-privilege first (the default for the add row). The SET
// must match the server's accepted WORKSPACE_ROLES (routes/admin.js).
const WORKSPACE_ROLES = ['workspace_viewer', 'workspace_editor', 'workspace_admin'];
const STAFF_ROLES = ['platform_admin', 'superadmin', 'platform_operator'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function roleOptions(selected) {
  return WORKSPACE_ROLES.map(r => `<option value="${r}"${r === selected ? ' selected' : ''}>${esc(t('members.role.' + r))}</option>`).join('');
}
const wsLabel = w => `${w.organization_name || '—'} / ${w.name}`;

// user: { id, name, email, role }; opts.onClose fires (once) if anything changed.
export function openManageWorkspacesModal(user, opts = {}) {
  const { onClose } = opts;
  const isStaff = STAFF_ROLES.includes(user.role);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${t('manage_ws.title', { user: esc(user.name || user.email) })}</h3>
        <button class="btn-icon" type="button" data-mws-close aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        ${isStaff ? `<p style="font-size:12px;color:var(--text-muted);background:var(--bg-input);padding:8px 10px;border-radius:6px;margin-bottom:12px">${t('manage_ws.staff_note')}</p>` : ''}
        <h4 style="font-size:14px;margin:0 0 8px">${t('manage_ws.current')}</h4>
        <div id="mwsList" style="color:var(--text-muted);font-size:13px">${t('common.loading')}</div>
        <h4 style="font-size:14px;margin:16px 0 8px">${t('manage_ws.add')}</h4>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input id="mwsFilter" type="text" class="input" placeholder="${t('manage_ws.filter')}" style="flex:1;min-width:150px" autocomplete="off">
          <select id="mwsAddWs" class="input" style="flex:2;min-width:170px"></select>
          <select id="mwsAddRole" class="input" style="width:auto">${roleOptions('workspace_viewer')}</select>
          <button class="btn btn-secondary" type="button" id="mwsAddBtn">${t('manage_ws.add_btn')}</button>
        </div>
        <div id="mwsError" style="display:none;color:var(--danger);font-size:13px;margin-top:8px"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" type="button" data-mws-close>${t('manage_ws.done')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector('#mwsList');
  const filterEl = overlay.querySelector('#mwsFilter');
  const addWsEl = overlay.querySelector('#mwsAddWs');
  const addRoleEl = overlay.querySelector('#mwsAddRole');
  const addBtn = overlay.querySelector('#mwsAddBtn');
  const errorEl = overlay.querySelector('#mwsError');

  let allWs = [];          // assignable workspaces (from /me)
  let memberships = [];    // current memberships
  let changed = false;     // refresh the table on close only if something changed

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (changed && typeof onClose === 'function') { try { onClose(); } catch (e) { console.error(e); } }
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-mws-close]').forEach(b => b.addEventListener('click', close));

  const showError = m => { errorEl.textContent = m; errorEl.style.display = 'block'; };
  const clearError = () => { errorEl.style.display = 'none'; };

  function renderAddOptions() {
    const memberIds = new Set(memberships.map(m => m.workspace_id));
    const f = (filterEl.value || '').trim().toLowerCase();
    const avail = allWs.filter(w => !memberIds.has(w.id) && (!f || wsLabel(w).toLowerCase().includes(f)));
    let html = `<option value="">${esc(t('manage_ws.pick'))}</option>`;
    let curOrg = null;
    for (const w of avail) {
      const org = w.organization_name || '—';
      if (org !== curOrg) { if (curOrg !== null) html += '</optgroup>'; html += `<optgroup label="${esc(org)}">`; curOrg = org; }
      html += `<option value="${esc(w.id)}">${esc(w.name)}</option>`;
    }
    if (curOrg !== null) html += '</optgroup>';
    addWsEl.innerHTML = html;
  }

  function renderList() {
    if (!memberships.length) {
      listEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('manage_ws.empty')}</p>`;
      return;
    }
    listEl.innerHTML = memberships.map(m => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
        <div style="flex:1;min-width:0">
          <div style="font-weight:500">${esc(m.workspace_name)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${esc(m.organization_name || '')}</div>
        </div>
        <select class="input" style="width:auto;font-size:12px;padding:4px;background:var(--bg-input)" data-mws-role="${esc(m.workspace_id)}">${roleOptions(m.role)}</select>
        <button class="btn btn-danger btn-sm" type="button" data-mws-remove="${esc(m.workspace_id)}">${t('manage_ws.remove')}</button>
      </div>
    `).join('');

    listEl.querySelectorAll('[data-mws-role]').forEach(sel => {
      sel.onchange = async () => {
        clearError();
        try { await api.adminSetUserWorkspaceRole(user.id, sel.dataset.mwsRole, sel.value); changed = true; showToast(t('manage_ws.toast.role'), 'success'); await reload(); }
        catch (e) { showError(e.message); await reload(); }
      };
    });
    listEl.querySelectorAll('[data-mws-remove]').forEach(btn => {
      btn.onclick = async () => {
        clearError();
        try { await api.adminRemoveUserWorkspace(user.id, btn.dataset.mwsRemove); changed = true; showToast(t('manage_ws.toast.removed'), 'success'); await reload(); }
        catch (e) { showError(e.message); await reload(); }
      };
    });
  }

  async function reload() {
    memberships = await api.adminGetUserWorkspaces(user.id).catch(() => memberships);
    renderList();
    renderAddOptions();
  }

  filterEl.addEventListener('input', renderAddOptions);
  addBtn.addEventListener('click', async () => {
    clearError();
    const wsId = addWsEl.value;
    const role = addRoleEl.value;
    if (!wsId) { showError(t('manage_ws.pick_required')); return; }
    addBtn.disabled = true;
    try {
      await api.adminAddUserWorkspace(user.id, wsId, role);
      changed = true;
      showToast(t('manage_ws.toast.added'), 'success');
      filterEl.value = '';
      await reload();
    } catch (e) { showError(e.message); }
    finally { addBtn.disabled = false; }
  });

  // initial load
  (async () => {
    try {
      const [mem, me] = await Promise.all([api.adminGetUserWorkspaces(user.id), api.getMe().catch(() => ({}))]);
      memberships = Array.isArray(mem) ? mem : [];
      allWs = Array.isArray(me?.accessible_workspaces) ? me.accessible_workspaces.slice() : [];
      renderList();
      renderAddOptions();
    } catch (e) {
      listEl.innerHTML = `<p style="color:var(--danger);font-size:13px">${esc(e.message || 'Failed to load')}</p>`;
    }
  })();
}
