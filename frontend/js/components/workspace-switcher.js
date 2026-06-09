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

// Admin affordances shown beside a workspace: manage members + rename. Returns
// '' for non-admins. Shared by the single-workspace view and the multi-workspace
// dropdown items so the two never drift - #19: the single view was missing these,
// locking single-workspace users out of org settings (invite users, perms, slug).
function adminIconsHtml(w) {
  if (!w.can_admin) return '';
  return `
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
    </button>`;
}

// Wire the manage-members + rename buttons within `scope`. `list` resolves a
// workspace id to its object (for the rename modal). stopPropagation so a click
// on an icon never triggers the row's switch handler.
function wireAdminIcons(scope, list) {
  scope.querySelectorAll('.workspace-switcher-pencil').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ws = list.find(w => w.id === btn.dataset.renameId);
      if (!ws) return;
      scope.classList.remove('open');
      const { openWorkspaceRenameModal } = await import('./workspace-rename-modal.js');
      openWorkspaceRenameModal(ws);
    });
  });
  scope.querySelectorAll('.workspace-switcher-members').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      scope.classList.remove('open');
      window.location.hash = `#/workspace/${btn.dataset.membersId}/members`;
    });
  });
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
    // #19: a single workspace still needs its admin affordances (manage members /
    // rename + slug). Render the name as before, plus the inline manage icons
    // when the user can administer it - no dropdown for one item.
    container.classList.remove('open');
    const only = list[0];
    container.innerHTML = `
      <div class="workspace-switcher-single">
        <span class="workspace-switcher-static">${esc(only.name)}</span>
        ${adminIconsHtml(only)}
      </div>`;
    wireAdminIcons(container, [only]);
    return;
  }

  // >1: dropdown. Alpha sort by workspace name for MVP (no recently-used yet).
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
  const current = sorted.find(w => w.id === currentId) || sorted[0];

  // Issue #16: show a type-to-filter search box once the list is big enough to
  // be painful to scroll (MSPs run 100+ orgs). Below the threshold a plain list
  // is fine. The full list is already loaded from /me, so filtering is client-side.
  const SHOW_SEARCH_THRESHOLD = 8;
  const showSearch = sorted.length >= SHOW_SEARCH_THRESHOLD;

  container.innerHTML = `
    <button class="workspace-switcher-button" type="button" aria-haspopup="listbox" aria-expanded="false">
      <span class="ws-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(current.name)}</span>
      <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </button>
    <div class="workspace-switcher-menu" role="listbox">
      ${showSearch ? `
      <div class="workspace-switcher-search">
        <input type="text" class="ws-search-input" placeholder="${t('switcher.search_placeholder')}"
               autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${t('switcher.search_placeholder')}">
      </div>` : ''}
      ${sorted.map(w => {
        const countStr = formatResourceCount(w.device_count, 'switcher.devices_count', 'switcher.no_devices');
        const orgName = w.organization_name || '';
        const subtitle = orgName && countStr ? esc(orgName) + ' · ' + esc(countStr)
                       : orgName            ? esc(orgName)
                       : countStr           ? esc(countStr)
                                            : '';
        // Searchable haystack: org name + workspace name, lowercased.
        const haystack = `${orgName} ${w.name}`.toLowerCase();
        return `
        <div class="workspace-switcher-item ${w.id === currentId ? 'current' : ''}" data-workspace-id="${esc(w.id)}" data-search="${esc(haystack)}" role="option">
          <svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="${w.id === currentId ? '' : 'visibility:hidden'}">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <div class="ws-meta">
            <div class="ws-name">${esc(w.name)}</div>
            <div class="ws-org">${subtitle}</div>
          </div>
          ${adminIconsHtml(w)}
        </div>
      `;
      }).join('')}
      <div class="workspace-switcher-noresults" style="display:none">${t('switcher.no_matches')}</div>
    </div>
  `;

  const button = container.querySelector('.workspace-switcher-button');
  const searchInput = container.querySelector('.ws-search-input'); // null below threshold

  // Shared switch action (used by click and keyboard Enter).
  async function switchTo(wsId) {
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
  }

  // ---- type-to-filter + keyboard navigation (only when the search box renders) ----
  const allItems = Array.from(container.querySelectorAll('.workspace-switcher-item'));
  const noResults = container.querySelector('.workspace-switcher-noresults');
  let highlightIdx = -1;
  const visibleItems = () => allItems.filter(it => it.style.display !== 'none');

  function setHighlight(idx) {
    const vis = visibleItems();
    allItems.forEach(it => it.classList.remove('highlighted'));
    if (!vis.length) { highlightIdx = -1; return; }
    highlightIdx = Math.max(0, Math.min(idx, vis.length - 1));
    const el = vis[highlightIdx];
    el.classList.add('highlighted');
    el.scrollIntoView({ block: 'nearest' });
  }

  function applyFilter(q) {
    const query = (q || '').trim().toLowerCase();
    let anyVisible = false;
    for (const it of allItems) {
      const match = !query || it.dataset.search.includes(query);
      it.style.display = match ? '' : 'none';
      if (match) anyVisible = true;
    }
    if (noResults) noResults.style.display = anyVisible ? 'none' : '';
    setHighlight(0);
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => applyFilter(searchInput.value));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(highlightIdx + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(highlightIdx - 1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const el = visibleItems()[highlightIdx];
        if (el) switchTo(el.dataset.workspaceId);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        container.classList.remove('open');
        button.setAttribute('aria-expanded', 'false');
        button.focus();
      }
    });
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !container.classList.contains('open');
    container.classList.toggle('open');
    button.setAttribute('aria-expanded', String(opening));
    // On open, reset the filter and focus the search box for immediate typing.
    if (opening && searchInput) {
      searchInput.value = '';
      applyFilter('');
      setTimeout(() => searchInput.focus(), 0);
    }
  });

  // Manage-members + rename icons (shared with the single-workspace view).
  wireAdminIcons(container, sorted);

  container.querySelectorAll('.workspace-switcher-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // Ignore clicks that originated on an icon button (each has its own handler).
      if (e.target.closest('.workspace-switcher-pencil, .workspace-switcher-members')) return;
      switchTo(item.dataset.workspaceId);
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
