// Add-User modal (#10). Sits next to the invite modal in the members view, but
// instead of emailing an invite it creates a user account directly with an
// admin-set password and assigns them to this workspace + role. For
// admin-provisioning on instances with no outbound email (where invites never
// deliver). Mirrors workspace-members-invite-modal.js's structure.
//
//   workspace: { id, name }
//   opts.onSuccess: (result) => void  - fires on 201 (server response body)
//   opts.mapError:  (err) => string   - translates server error to display text
import { api } from '../api.js';
import { t } from '../i18n.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Crockford-ish readable random password: avoids ambiguous chars (0/O, 1/l/I).
function generatePassword(len = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[arr[i] % alphabet.length];
  return out;
}

export function openAddUserModal(workspace, opts = {}) {
  const { onSuccess, mapError } = opts;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${t('members.modal.add_user_title', { workspace: esc(workspace.name) })}</h3>
        <button class="btn-icon" type="button" data-add-close aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label for="addUserEmail">${t('members.modal.email_label')}</label>
          <input id="addUserEmail" type="email" class="input" placeholder="${t('members.modal.email_placeholder')}" style="width:100%" autocomplete="off" autocapitalize="off" spellcheck="false">
        </div>
        <div class="form-group">
          <label for="addUserName">${t('members.modal.name_label')}</label>
          <input id="addUserName" type="text" class="input" placeholder="${t('members.modal.name_placeholder')}" style="width:100%" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="addUserPassword">${t('members.modal.password_label')}</label>
          <div style="display:flex;gap:8px">
            <input id="addUserPassword" type="text" class="input" placeholder="${t('members.modal.password_placeholder')}" style="flex:1" autocomplete="off" autocapitalize="off" spellcheck="false">
            <button class="btn btn-secondary" type="button" id="addUserGenerate" style="white-space:nowrap">${t('members.modal.generate')}</button>
          </div>
        </div>
        <div class="form-group">
          <label for="addUserRole">${t('members.modal.role_label')}</label>
          <select id="addUserRole" class="input" style="width:100%">
            <option value="workspace_viewer">${t('members.role.workspace_viewer')}</option>
            <option value="workspace_editor">${t('members.role.workspace_editor')}</option>
            <option value="workspace_admin">${t('members.role.workspace_admin')}</option>
          </select>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
          <input id="addUserMustChange" type="checkbox" checked>
          ${t('members.modal.must_change_label')}
        </label>
        <div id="addUserError" style="display:none;color:var(--danger);font-size:13px;margin-top:8px"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-add-close>${t('members.modal.cancel')}</button>
        <button class="btn btn-primary" type="button" id="addUserSubmit">${t('members.modal.create')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const emailInput = overlay.querySelector('#addUserEmail');
  const nameInput = overlay.querySelector('#addUserName');
  const pwInput = overlay.querySelector('#addUserPassword');
  const genBtn = overlay.querySelector('#addUserGenerate');
  const roleSelect = overlay.querySelector('#addUserRole');
  const mustChange = overlay.querySelector('#addUserMustChange');
  const errorEl = overlay.querySelector('#addUserError');
  const submitBtn = overlay.querySelector('#addUserSubmit');
  emailInput.focus();

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-add-close]').forEach(b => b.addEventListener('click', close));
  genBtn.addEventListener('click', () => { pwInput.value = generatePassword(); pwInput.type = 'text'; });

  async function submit() {
    errorEl.style.display = 'none';
    const email = emailInput.value.trim().toLowerCase();
    const name = nameInput.value.trim();
    const password = pwInput.value;
    const role = roleSelect.value;
    if (!email || !EMAIL_RE.test(email)) { showError(t('members.error.invalid_email')); emailInput.focus(); return; }
    if (!password || password.length < 8) { showError(t('members.error.password_min_8')); pwInput.focus(); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = t('members.modal.creating');
    try {
      const result = await api.adminCreateUser({
        email, name, password, role,
        workspaceId: workspace.id,
        mustChangePassword: mustChange.checked,
      });
      close();
      if (typeof onSuccess === 'function') {
        try { onSuccess(result); }
        catch (e) { console.error('add-user modal onSuccess threw:', e); }
      }
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = t('members.modal.create');
      const msg = (typeof mapError === 'function')
        ? mapError(err)
        : (err?.message || t('members.error.mutation_generic', { error: '' }));
      showError(msg);
    }
  }

  function showError(msg) { errorEl.textContent = msg; errorEl.style.display = 'block'; }

  submitBtn.addEventListener('click', submit);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
