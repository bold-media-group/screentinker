import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc, isPlatformAdmin } from '../utils.js';
import { t } from '../i18n.js';

const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' });
const API = (url, opts = {}) => fetch('/api' + url, { headers: headers(), ...opts }).then(r => r.json());

// #14: the platform user-management dropdown manages users.role (the
// PLATFORM-level role) only - workspace/org roles are managed in the members
// views. Options are the current model; the legacy 'admin'/'superadmin' strings
// were normalized away. #13 adds 'platform_operator' (cross-org staff).
const PLATFORM_ROLE_OPTIONS = ['user', 'platform_operator', 'platform_admin'];

export async function render(container) {
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  if (!isPlatformAdmin(user)) {
    container.innerHTML = `<div class="empty-state"><h3>${t('admin.access_denied')}</h3><p>${t('admin.access_denied_desc')}</p></div>`;
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('admin.title')}</h1><div class="subtitle">${t('admin.subtitle')}</div></div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.all_users')}</h3>
      <div id="allUsersTable"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.plans')}</h3>
      <div id="plansTable"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>

    <div class="settings-section">
      <h3>${t('admin.system')}</h3>
      <div id="systemInfo"><p style="color:var(--text-muted)">${t('common.loading')}</p></div>
    </div>
  `;

  loadUsers();
  loadPlans();
  loadSystem();

}

async function loadUsers() {
  const el = document.getElementById('allUsersTable');
  try {
    const [users, plans] = await Promise.all([API('/auth/users'), fetch('/api/subscription/plans').then(r => r.json())]);
    const currentUser = JSON.parse(localStorage.getItem('user') || '{}');

    el.innerHTML = `
      <div class="table-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:720px">
        <thead><tr style="border-bottom:1px solid var(--border)">
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.user')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.auth')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.last_login')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.role')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.plan')}</th>
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.actions')}</th>
        </tr></thead>
        <tbody>
          ${users.map(u => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:8px"><div style="font-weight:500">${u.name || u.email}</div><div style="font-size:11px;color:var(--text-muted)">${u.email}</div></td>
              <td style="padding:8px"><span style="background:var(--bg-primary);padding:2px 8px;border-radius:10px;font-size:11px">${u.auth_provider}</span></td>
              <td style="padding:8px;font-size:11px;color:var(--text-muted)">${u.last_login ? new Date(u.last_login * 1000).toLocaleString() : t('common.never')}</td>
              <td style="padding:8px">
                <select class="input" style="max-width:120px;width:100%;background:var(--bg-input);font-size:12px;padding:4px" data-role-user="${u.id}">
                  ${PLATFORM_ROLE_OPTIONS.map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${t('admin.role.' + r)}</option>`).join('')}
                </select>
              </td>
              <td style="padding:8px">
                <select class="input" style="max-width:130px;width:100%;background:var(--bg-input);font-size:12px;padding:4px" data-plan-user="${u.id}">
                  ${plans.map(p => `<option value="${p.id}" ${u.plan_id === p.id ? 'selected' : ''}>${p.display_name}</option>`).join('')}
                </select>
              </td>
              <td style="padding:8px;white-space:nowrap">
                ${u.auth_provider === 'local' && u.id !== currentUser.id ? `<button class="btn btn-secondary btn-sm" data-reset-pw-user="${u.id}" data-user-email="${u.email}" style="margin-right:4px">${t('admin.reset_password')}</button>` : ''}
                ${!isPlatformAdmin(u) ? `<button class="btn btn-danger btn-sm" data-delete-user="${u.id}">${t('admin.remove')}</button>` : `<span style="color:var(--text-muted);font-size:11px">${t('admin.owner')}</span>`}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
      <p style="color:var(--text-muted);font-size:11px;margin-top:8px">${t('admin.total_users', { n: users.length })}</p>
    `;

    el.querySelectorAll('[data-role-user]').forEach(select => {
      select.onchange = async () => {
        try {
          await API(`/auth/users/${select.dataset.roleUser}/role`, { method: 'PUT', body: JSON.stringify({ role: select.value }) });
          showToast(t('admin.toast.role_updated'), 'success');
        } catch (err) { showToast(err.message, 'error'); loadUsers(); }
      };
    });

    el.querySelectorAll('[data-plan-user]').forEach(select => {
      select.onchange = async () => {
        try {
          await API('/subscription/assign', { method: 'POST', body: JSON.stringify({ user_id: select.dataset.planUser, plan_id: select.value }) });
          showToast(t('admin.toast.plan_updated'), 'success');
        } catch (err) { showToast(err.message, 'error'); loadUsers(); }
      };
    });

    // Reset password handlers
    el.querySelectorAll('[data-reset-pw-user]').forEach(btn => {
      btn.onclick = async () => {
        const email = btn.dataset.userEmail;
        const pw = prompt(t('admin.prompt_reset_password', { email }));
        if (pw === null) return;
        if (pw.length < 8) { showToast(t('admin.toast.password_min_8'), 'error'); return; }
        try {
          await api.resetUserPassword(btn.dataset.resetPwUser, pw);
          showToast(t('admin.toast.password_reset'), 'success');
        } catch (err) { showToast(err.message, 'error'); }
      };
    });

    el.querySelectorAll('[data-delete-user]').forEach(btn => {
      let confirming = false;
      btn.onclick = async () => {
        if (confirming) {
          try { await api.deleteUser(btn.dataset.deleteUser); showToast(t('admin.toast.user_removed'), 'success'); loadUsers(); }
          catch (err) { showToast(err.message, 'error'); }
          return;
        }
        confirming = true; btn.textContent = t('admin.confirm'); btn.style.background = 'var(--danger)'; btn.style.color = 'white';
        setTimeout(() => { confirming = false; btn.textContent = t('admin.remove'); btn.style.background = ''; btn.style.color = ''; }, 3000);
      };
    });
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; }
}

async function loadPlans() {
  const el = document.getElementById('plansTable');
  try {
    const plans = await fetch('/api/subscription/plans').then(r => r.json());
    el.innerHTML = `
      <div class="table-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:500px">
        <thead><tr style="border-bottom:1px solid var(--border)">
          <th style="padding:8px;text-align:left;color:var(--text-muted)">${t('admin.col.plan')}</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('admin.col.devices')}</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('admin.col.storage')}</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('admin.col.monthly')}</th>
          <th style="padding:8px;text-align:right;color:var(--text-muted)">${t('admin.col.yearly')}</th>
        </tr></thead>
        <tbody>
          ${plans.map(p => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:8px;font-weight:500">${p.display_name}</td>
              <td style="padding:8px;text-align:right">${p.max_devices === -1 ? t('admin.unlimited') : p.max_devices}</td>
              <td style="padding:8px;text-align:right">${p.max_storage_mb === -1 ? t('admin.unlimited') : p.max_storage_mb >= 1024 ? (p.max_storage_mb/1024)+'GB' : p.max_storage_mb+'MB'}</td>
              <td style="padding:8px;text-align:right">${p.price_monthly > 0 ? '$'+p.price_monthly : t('admin.free')}</td>
              <td style="padding:8px;text-align:right">${p.price_yearly > 0 ? '$'+p.price_yearly : '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
    `;
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; }
}

async function loadSystem() {
  const el = document.getElementById('systemInfo');
  try {
    const version = await fetch('/api/version').then(r => r.json());
    const token = localStorage.getItem('token');
    el.innerHTML = `
      <div class="info-grid">
        <div class="info-card"><div class="info-card-label">${t('admin.version')}</div><div class="info-card-value small">${version.version}</div></div>
        <div class="info-card"><div class="info-card-label">${t('admin.frontend_hash')}</div><div class="info-card-value small">${version.hash}</div></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <a href="/api/status/backup?token=${token}" class="btn btn-secondary btn-sm" style="text-decoration:none">${t('admin.download_db_backup')}</a>
        <a href="/api/status" target="_blank" class="btn btn-secondary btn-sm" style="text-decoration:none">${t('admin.server_status')}</a>
      </div>
    `;
  } catch (err) { el.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`; }
}

export function cleanup() {}
