import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

const API = (url, opts = {}) => fetch('/api' + url, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}`, ...opts.headers }, ...opts }).then(r => r.json());

export async function render(container) {
  const hash = window.location.hash;
  if (hash.startsWith('#/wall/')) {
    const id = hash.split('#/wall/')[1];
    return renderWallEditor(container, id);
  }
  return renderList(container);
}

async function renderList(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><h1>${t('wall.title')} <span class="help-tip" data-tip="${t('wall.help_tip')}">?</span></h1><div class="subtitle">${t('wall.subtitle')}</div></div>
      <button class="btn btn-primary" id="newWallBtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        ${t('wall.new_wall')}
      </button>
    </div>
    <div class="content-grid" id="wallGrid"></div>
  `;

  document.getElementById('newWallBtn').onclick = async () => {
    const name = prompt(t('wall.prompt_name'));
    if (!name) return;
    const wall = await API('/walls', { method: 'POST', body: JSON.stringify({ name }) });
    window.location.hash = `#/wall/${wall.id}`;
  };

  try {
    const walls = await API('/walls');
    const grid = document.getElementById('wallGrid');

    if (!walls.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>${t('wall.empty_title')}</h3><p>${t('wall.empty_desc')}</p></div>`;
      return;
    }

    grid.innerHTML = walls.map(w => `
      <div class="content-item" style="cursor:pointer" onclick="window.location.hash='#/wall/${w.id}'">
        <div class="content-item-preview" style="display:flex;align-items:center;justify-content:center;background:var(--bg-primary)">
          <div style="display:grid;grid-template-columns:repeat(${w.grid_cols},1fr);gap:3px;width:60%;aspect-ratio:${w.grid_cols}/${w.grid_rows}">
            ${Array.from({ length: w.grid_cols * w.grid_rows }, (_, i) => {
              const row = Math.floor(i / w.grid_cols);
              const col = i % w.grid_cols;
              const dev = w.devices?.find(d => d.grid_col === col && d.grid_row === row);
              return `<div style="background:${dev ? 'rgba(59,130,246,0.3)' : 'var(--bg-card)'};border:1px solid ${dev ? 'var(--accent)' : 'var(--border)'};border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:8px;color:var(--text-muted);aspect-ratio:16/9">${dev?.device_name?.slice(0, 6) || ''}</div>`;
            }).join('')}
          </div>
        </div>
        <div class="content-item-body">
          <div class="content-item-name">${w.name}</div>
          <div class="content-item-size">${t('wall.grid_summary', { cols: w.grid_cols, rows: w.grid_rows, n: w.devices?.length || 0 })}</div>
        </div>
      </div>
    `).join('');
  } catch (err) { showToast(err.message, 'error'); }
}

async function renderWallEditor(container, wallId) {
  let wall, devices;
  try {
    [wall, devices] = await Promise.all([API(`/walls/${wallId}`), api.getDevices()]);
  } catch { container.innerHTML = `<div class="empty-state"><h3>${t('wall.not_found')}</h3></div>`; return; }

  const content = await api.getContent();
  const unassigned = devices.filter(d => !wall.devices?.find(wd => wd.device_id === d.id));

  container.innerHTML = `
    <a href="#/walls" class="back-link" style="display:inline-flex;align-items:center;gap:6px;color:var(--text-secondary);margin-bottom:16px;font-size:13px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      ${t('wall.back')}
    </a>
    <div class="page-header">
      <h1>${wall.name}</h1>
      <div style="display:flex;gap:8px">
        <button class="btn btn-danger btn-sm" id="deleteWallBtn">${t('wall.delete_wall')}</button>
      </div>
    </div>

    <div style="display:flex;gap:24px">
      <div style="flex:1">
        <h3 style="font-size:14px;margin-bottom:12px">${t('wall.grid_config')}</h3>
        <div style="display:flex;gap:12px;margin-bottom:16px">
          <div class="form-group" style="margin:0"><label>${t('wall.columns')}</label><input type="number" id="gridCols" class="input" value="${wall.grid_cols}" min="1" max="10" style="width:80px"></div>
          <div class="form-group" style="margin:0"><label>${t('wall.rows')}</label><input type="number" id="gridRows" class="input" value="${wall.grid_rows}" min="1" max="10" style="width:80px"></div>
          <div class="form-group" style="margin:0"><label>${t('wall.h_bezel')}</label><input type="number" id="bezelH" class="input" value="${wall.bezel_h_mm}" min="0" step="0.5" style="width:80px"></div>
          <div class="form-group" style="margin:0"><label>${t('wall.v_bezel')}</label><input type="number" id="bezelV" class="input" value="${wall.bezel_v_mm}" min="0" step="0.5" style="width:80px"></div>
          <button class="btn btn-primary btn-sm" id="updateGridBtn" style="align-self:flex-end">${t('wall.update')}</button>
        </div>

        <div id="wallGrid" style="display:inline-grid;gap:4px;background:var(--bg-primary);padding:16px;border:1px solid var(--border);border-radius:var(--radius-lg)"></div>

        <h3 style="font-size:14px;margin:24px 0 12px">${t('wall.content')}</h3>
        <select id="wallContent" class="input" style="width:300px;background:var(--bg-input)">
          <option value="">${t('wall.no_content')}</option>
          ${content.filter(c => c.mime_type?.startsWith('video/')).map(c => `<option value="${c.id}" ${c.id === wall.content_id ? 'selected' : ''}>${esc(c.filename)}</option>`).join('')}
        </select>
        <button class="btn btn-primary btn-sm" id="setContentBtn" style="margin-left:8px">${t('wall.set_content')}</button>
      </div>

      <div style="width:250px">
        <h3 style="font-size:14px;margin-bottom:12px">${t('wall.available_displays')}</h3>
        <div id="availableDevices">
          ${unassigned.map(d => `
            <div class="playlist-item" style="cursor:grab;margin-bottom:4px" draggable="true" data-device-id="${d.id}" data-device-name="${d.name}">
              <div class="playlist-item-info">
                <div class="playlist-item-name">${d.name}</div>
                <div class="playlist-item-meta"><span class="status-dot ${d.status}" style="display:inline-block"></span> ${d.status}</div>
              </div>
            </div>
          `).join('') || `<p style="color:var(--text-muted);font-size:12px">${t('wall.all_assigned')}</p>`}
        </div>
      </div>
    </div>
  `;

  function renderGrid() {
    const cols = parseInt(document.getElementById('gridCols').value) || 2;
    const rows = parseInt(document.getElementById('gridRows').value) || 2;
    const grid = document.getElementById('wallGrid');
    grid.style.gridTemplateColumns = `repeat(${cols}, 120px)`;

    let html = '';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const dev = wall.devices?.find(d => d.grid_col === c && d.grid_row === r);
        html += `
          <div style="width:120px;aspect-ratio:16/9;background:${dev ? 'rgba(59,130,246,0.2)' : 'var(--bg-card)'};
            border:2px ${dev ? 'solid var(--accent)' : 'dashed var(--border)'};border-radius:var(--radius);
            display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:11px;color:var(--text-secondary)"
            data-grid-col="${c}" data-grid-row="${r}">
            ${dev ? `<div style="font-weight:500">${dev.device_name}</div><div style="font-size:9px;color:var(--text-muted)">[${c},${r}]</div>` :
              `<div style="color:var(--text-muted)">${t('wall.drop_here')}</div><div style="font-size:9px">[${c},${r}]</div>`}
          </div>
        `;
      }
    }
    grid.innerHTML = html;

    grid.querySelectorAll('[data-grid-col]').forEach(cell => {
      cell.ondragover = (e) => { e.preventDefault(); cell.style.borderColor = 'var(--success)'; };
      cell.ondragleave = () => { cell.style.borderColor = ''; };
      cell.ondrop = async (e) => {
        e.preventDefault();
        cell.style.borderColor = '';
        const deviceId = e.dataTransfer.getData('device-id');
        const deviceName = e.dataTransfer.getData('device-name');
        const col = parseInt(cell.dataset.gridCol);
        const row = parseInt(cell.dataset.gridRow);

        const existing = wall.devices?.filter(d => !(d.grid_col === col && d.grid_row === row)) || [];
        existing.push({ device_id: deviceId, device_name: deviceName, grid_col: col, grid_row: row });

        try {
          const updated = await API(`/walls/${wallId}/devices`, { method: 'PUT', body: JSON.stringify({ devices: existing }) });
          wall.devices = updated.devices;
          renderGrid();
          showToast(t('wall.toast.placed', { name: deviceName, col, row }), 'success');
        } catch (err) { showToast(err.message, 'error'); }
      };
    });
  }

  container.querySelectorAll('[draggable]').forEach(el => {
    el.ondragstart = (e) => {
      e.dataTransfer.setData('device-id', el.dataset.deviceId);
      e.dataTransfer.setData('device-name', el.dataset.deviceName);
    };
  });

  document.getElementById('updateGridBtn').onclick = async () => {
    try {
      await API(`/walls/${wallId}`, { method: 'PUT', body: JSON.stringify({
        grid_cols: parseInt(document.getElementById('gridCols').value),
        grid_rows: parseInt(document.getElementById('gridRows').value),
        bezel_h_mm: parseFloat(document.getElementById('bezelH').value),
        bezel_v_mm: parseFloat(document.getElementById('bezelV').value),
      })});
      wall.grid_cols = parseInt(document.getElementById('gridCols').value);
      wall.grid_rows = parseInt(document.getElementById('gridRows').value);
      renderGrid();
      showToast(t('wall.toast.grid_updated'), 'success');
    } catch (err) { showToast(err.message, 'error'); }
  };

  document.getElementById('setContentBtn').onclick = async () => {
    const contentId = document.getElementById('wallContent').value;
    try {
      await API(`/walls/${wallId}/content`, { method: 'PUT', body: JSON.stringify({ content_id: contentId || null }) });
      showToast(t('wall.toast.content_updated'), 'success');
    } catch (err) { showToast(err.message, 'error'); }
  };

  document.getElementById('deleteWallBtn').onclick = async () => {
    try {
      await API(`/walls/${wallId}`, { method: 'DELETE' });
      showToast(t('wall.toast.deleted'), 'success');
      window.location.hash = '#/walls';
    } catch (err) { showToast(err.message, 'error'); }
  };

  renderGrid();
}

export function cleanup() {}
