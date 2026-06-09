// #10: forced first-login password change. When an admin provisions a user
// with must_change_password=1, route() in app.js redirects them here and blocks
// every other view until they set a new password. Reuses the same PUT /api/auth/me
// path as the Settings change-password form; on success the server clears
// must_change_password, we refresh the cached user, and return to the app.
import { api } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from '../components/toast.js';

export async function render(container) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px">
      <div style="width:400px;max-width:100%">
        <div style="text-align:center;margin-bottom:24px">
          <h1 style="font-size:22px;font-weight:700;color:var(--accent)">${t('forcepw.title')}</h1>
          <p style="color:var(--text-secondary);font-size:13px;margin-top:6px">${t('forcepw.subtitle')}</p>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px">
          <div class="form-group">
            <label>${t('forcepw.current')}</label>
            <input type="password" id="fpwCurrent" class="input" autocomplete="current-password">
          </div>
          <div class="form-group">
            <label>${t('forcepw.new')}</label>
            <input type="password" id="fpwNew" class="input" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label>${t('forcepw.confirm')}</label>
            <input type="password" id="fpwConfirm" class="input" autocomplete="new-password">
          </div>
          <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">${t('forcepw.hint')}</p>
          <button class="btn btn-primary" id="fpwSubmit" style="width:100%;justify-content:center;padding:10px">${t('forcepw.submit')}</button>
          <p id="fpwError" style="color:var(--danger);font-size:12px;text-align:center;margin-top:12px;display:none"></p>
        </div>
      </div>
    </div>
  `;

  const current = container.querySelector('#fpwCurrent');
  const next = container.querySelector('#fpwNew');
  const confirm = container.querySelector('#fpwConfirm');
  const submit = container.querySelector('#fpwSubmit');
  const errorEl = container.querySelector('#fpwError');
  current.focus();

  const showError = (msg) => { errorEl.textContent = msg; errorEl.style.display = 'block'; };

  async function doChange() {
    errorEl.style.display = 'none';
    const cur = current.value;
    const nw = next.value;
    const cf = confirm.value;
    if (!cur || !nw) { showError(t('forcepw.error_required')); return; }
    if (nw.length < 8) { showError(t('forcepw.error_min8')); return; }
    if (nw !== cf) { showError(t('forcepw.error_mismatch')); return; }

    submit.disabled = true;
    submit.textContent = t('forcepw.submitting');
    try {
      await api.updateMe({ password: nw, current_password: cur });
      // Refresh the cached user so the (now-cleared) must_change_password flag
      // is reflected, then return to the app.
      try {
        const fresh = await api.getMe();
        localStorage.setItem('user', JSON.stringify(fresh));
      } catch { /* fall through; reload re-fetches */ }
      showToast(t('forcepw.success'), 'success');
      window.location.hash = '#/';
      window.location.reload();
    } catch (err) {
      submit.disabled = false;
      submit.textContent = t('forcepw.submit');
      showError(err?.message || t('forcepw.error_generic'));
    }
  }

  submit.addEventListener('click', doChange);
  [current, next, confirm].forEach(el => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doChange(); }));
}

export function cleanup() {}
