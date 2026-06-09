import { api } from '../api.js';
import { t } from '../i18n.js';

// Create-Organization modal (#35). Platform-admin only (the page is gated; the
// endpoint re-checks). Creates a named org + its first "Default" workspace, owned
// by the creating admin (organizations.owner_user_id is NOT NULL). On success the
// org appears in the switcher, so we reload to refresh it — matching the
// workspace rename/switch flow. opts.onSuccess(result) fires before reload.
export function openCreateOrgModal(opts = {}) {
  const { onSuccess } = opts;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${t('admin.create_org.title')}</h3>
        <button class="btn-icon" type="button" data-org-close aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label for="createOrgName">${t('admin.create_org.name')}</label>
          <input id="createOrgName" type="text" class="input" maxlength="120" placeholder="${t('admin.create_org.placeholder')}" style="width:100%">
          <div style="color:var(--text-muted);font-size:11px;margin-top:4px">${t('admin.create_org.hint')}</div>
        </div>
        <div id="createOrgError" style="display:none;color:var(--danger);font-size:13px;margin-top:8px"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" data-org-close>${t('common.cancel')}</button>
        <button class="btn btn-primary" type="button" id="createOrgSave">${t('admin.create_org.submit')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const nameInput = overlay.querySelector('#createOrgName');
  const errorEl = overlay.querySelector('#createOrgError');
  const saveBtn = overlay.querySelector('#createOrgSave');
  nameInput.focus();

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && e.target === nameInput) save();
  }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-org-close]').forEach(b => b.addEventListener('click', close));

  async function save() {
    errorEl.style.display = 'none';
    const name = nameInput.value.trim();
    if (!name) { showError(t('admin.create_org.err_empty')); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = t('common.saving');
    try {
      const result = await api.adminCreateOrg(name);
      if (typeof onSuccess === 'function') onSuccess(result);
      window.location.reload();
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = t('admin.create_org.submit');
      showError(err.message || t('admin.create_org.err_failed'));
    }
  }
  function showError(msg) { errorEl.textContent = msg; errorEl.style.display = 'block'; }

  saveBtn.addEventListener('click', save);
}
