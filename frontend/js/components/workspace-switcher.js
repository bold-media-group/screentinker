import { api } from '../api.js';
import { showToast } from './toast.js';
import { t, tn } from '../i18n.js';

// Reusable resource-count formatter. Returns localized "1 device" / "N devices"
// / "No devices" based on n. Generic so the same shape can wire users /
// playlists / schedules counts later without refactor - caller supplies the
// i18n key bases.
//   keyBase: e.g. 'switcher.devices_count' (looks up _one / _other variants via tn)
//   zeroKey: e.g. 'switcher.no_devices' (direct lookup for n === 0)
function formatResourceCount(n, keyBase, zeroKey) {
  if (n === undefined || n === null) return '';
  if (n === 0) return t(zeroKey);
  return tn(keyBase, n);
}

// Render the workspace switcher inside #workspaceSwitcher based on the
// /api/auth/me response. Three modes:
//   - 0 accessible workspaces: muted "No workspace" placeholder
//   - 1 accessible workspace: workspace name as static text
//   - >1 accessible workspaces: dropdown button + menu with click-to-switch
export function renderWorkspaceSwitcher(me) {
  const container = document.getElementById('workspaceSwitcher');
  if (!container) return;

  const list = Array.isArray(me?.accessible_workspaces) ? me.accessible_workspaces : [];
  const currentId = me?.current_workspace_id || null;

  if (list.length === 0) {
    container.classList.remove('open');
    container.innerHTML = `<span class="workspace-switcher-empty">No workspace</span>`;
    return;
  }

  if (list.length === 1) {
    container.classList.remove('open');
    container.innerHTML = `<span class="workspace-switcher-static">${esc(list[0].name)}</span>`;
    return;
  }

  // >1: dropdown. Alpha sort by workspace name for MVP (no recently-used yet).
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
  const current = sorted.find(w => w.id === currentId) || sorted[0];

  container.innerHTML = `
    <button class="workspace-switcher-button" type="button" aria-haspopup="listbox" aria-expanded="false">
      <span class="ws-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(current.name)}</span>
      <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </button>
    <div class="workspace-switcher-menu" role="listbox">
      ${sorted.map(w => {
        const countStr = formatResourceCount(w.device_count, 'switcher.devices_count', 'switcher.no_devices');
        const orgName = w.organization_name || '';
        const subtitle = orgName && countStr ? esc(orgName) + ' · ' + esc(countStr)
                       : orgName            ? esc(orgName)
                       : countStr           ? esc(countStr)
                                            : '';
        return `
        <div class="workspace-switcher-item ${w.id === currentId ? 'current' : ''}" data-workspace-id="${esc(w.id)}" role="option">
          <svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="${w.id === currentId ? '' : 'visibility:hidden'}">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <div class="ws-meta">
            <div class="ws-name">${esc(w.name)}</div>
            <div class="ws-org">${subtitle}</div>
          </div>
          ${w.can_admin ? `
            <button class="workspace-switcher-members" type="button" data-members-id="${esc(w.id)}" aria-label="Manage members" title="Manage members">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
            </button>
            <button class="workspace-switcher-pencil" type="button" data-rename-id="${esc(w.id)}" aria-label="Rename workspace" title="Rename">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
              </svg>
            </button>
          ` : ''}
        </div>
      `;
      }).join('')}
    </div>
  `;

  const button = container.querySelector('.workspace-switcher-button');
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !container.classList.contains('open');
    container.classList.toggle('open');
    button.setAttribute('aria-expanded', String(opening));
  });

  // Pencil click opens the rename modal. Must stopPropagation so the click
  // doesn't bubble up to the switcher-item's switch handler.
  container.querySelectorAll('.workspace-switcher-pencil').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const wsId = btn.dataset.renameId;
      const ws = sorted.find(w => w.id === wsId);
      if (!ws) return;
      container.classList.remove('open');
      const { openWorkspaceRenameModal } = await import('./workspace-rename-modal.js');
      openWorkspaceRenameModal(ws);
    });
  });

  // Members icon navigates to the workspace members page. Same stopPropagation
  // pattern as the pencil so the click doesn't trigger workspace-switch.
  container.querySelectorAll('.workspace-switcher-members').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wsId = btn.dataset.membersId;
      container.classList.remove('open');
      window.location.hash = `#/workspace/${wsId}/members`;
    });
  });

  container.querySelectorAll('.workspace-switcher-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      // Ignore clicks that originated on an icon button (each has its own handler).
      if (e.target.closest('.workspace-switcher-pencil, .workspace-switcher-members')) return;
      const wsId = item.dataset.workspaceId;
      if (wsId === currentId) { container.classList.remove('open'); return; }
      try {
        const resp = await api.switchWorkspace(wsId);
        if (resp?.token) {
          localStorage.setItem('token', resp.token);
          window.location.reload();
        } else {
          showToast('Switch returned no token', 'error');
        }
      } catch (err) {
        showToast(err.message || 'Failed to switch workspace', 'error');
      }
    });
  });

  // Click-outside closes the menu.
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) {
      container.classList.remove('open');
      button.setAttribute('aria-expanded', 'false');
    }
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
