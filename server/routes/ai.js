'use strict';

// #41: AI content design. Bring-your-own OpenAI-COMPATIBLE endpoint (OpenAI cloud
// or self-hosted Ollama / LM Studio / llama.cpp) generates a *structured* design
// spec that the existing Designer renders with real fonts — so text is crisp and
// editable (raw image-gen garbles text). The operator bears no AI cost; each
// workspace configures its own endpoint/key (encrypted at rest, never returned).
const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const config = require('../config');
const { encrypt, decrypt } = require('../lib/secretbox');
const { logActivity, getClientIp } = require('../services/activity');

const isWorkspaceAdmin = (req) => req.isPlatformAdmin || req.actingAs || req.workspaceRole === 'workspace_admin';
const canEdit = (req) => req.isPlatformAdmin || req.actingAs || ['workspace_admin', 'workspace_editor'].includes(req.workspaceRole);

// SSRF guard. Self-hosted instances may point at localhost/LAN (the whole point);
// the hosted instance must not let a tenant admin reach the host's private network.
function endpointAllowed(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (config.selfHosted) return true;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local')) return false;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (/^(fc|fd)/.test(h)) return false; // IPv6 ULA
  return true;
}

const DESIGN_SYSTEM_PROMPT =
`You are a digital-signage designer. The canvas is 1920x1080 (16:9). Respond with ONLY a JSON object (no prose, no markdown fences) shaped exactly:
{"background":"#RRGGBB","elements":[ELEMENT, ...]}
ELEMENT is one of:
{"type":"text","x":N,"y":N,"text":"STRING","fontSize":N,"color":"#RRGGBB","bold":true|false}
{"type":"shape","x":N,"y":N,"width":N,"height":N,"color":"#RRGGBB","opacity":N}
x, y, width, height are PERCENTAGES of the canvas (0-100). fontSize is a number where a big headline is about 90 and body text about 36. Use 3 to 6 elements: one bold headline, 1-2 supporting lines, and 0-2 shapes as colored accent bands behind/beside the text. Pick a tasteful, high-contrast palette that fits the request. Keep every element within 0-95 on both axes. Output JSON only.`;

const clampN = (n, lo, hi, d) => { n = Number(n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const hex = (c, d) => (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.trim())) ? c.trim() : d;
const cleanText = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '').trim().slice(0, 200);

// Keep generated text on the canvas. The Designer renders text nowrap at
// ~fontSize/10 % of the canvas width per em, so long/large text runs off the
// edge. Estimate width = chars * fontSize * 0.06 (% of canvas width) and height
// = fontSize * 0.18 (% of canvas height); shrink fontSize to fit within 4%
// margins, then nudge x/y in-bounds. Deterministic, so it doesn't depend on the
// model getting layout right.
function fitText(el) {
  // CW: width-% per (char * fontSize). 0.075 ~ bold/uppercase headlines (wider
  // than mixed-case). CH: height-% per fontSize incl. line-height.
  const M = 4, CW = 0.075, CH = 0.22;
  const len = Math.max(1, el.text.length);
  const maxByW = (100 - 2 * M) / (len * CW);
  const maxByH = (100 - 2 * M) / CH;
  el.fontSize = Math.floor(Math.max(8, Math.min(el.fontSize, maxByW, maxByH)));
  const w = len * el.fontSize * CW;
  const h = el.fontSize * CH;
  el.x = Math.round(Math.min(Math.max(el.x, M), Math.max(M, 100 - M - w)) * 10) / 10;
  el.y = Math.round(Math.min(Math.max(el.y, M), Math.max(M, 100 - M - h)) * 10) / 10;
}

// Never trust raw model output: cap count, clamp ranges, fix px-vs-% (models
// often emit pixels), strip any HTML from text, validate colors, fit to canvas.
function normalizeDesign(raw) {
  const out = { background: hex(raw && raw.background, '#111827'), elements: [] };
  const els = Array.isArray(raw && raw.elements) ? raw.elements.slice(0, 20) : [];
  for (const e of els) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'text') {
      const text = cleanText(e.text);
      if (!text) continue;
      const el = {
        type: 'text', x: clampN(e.x, 0, 95, 5), y: clampN(e.y, 0, 95, 5), text,
        fontSize: clampN(e.fontSize, 12, 200, 48), fontFamily: 'Arial',
        color: hex(e.color, '#FFFFFF'), bold: !!e.bold, shadow: !!e.shadow,
      };
      fitText(el);
      out.elements.push(el);
    } else if (e.type === 'shape') {
      let w = Number(e.width), h = Number(e.height);
      if (w > 100) w = w / 19.2;  // px of 1920 -> %
      if (h > 100) h = h / 10.8;  // px of 1080 -> %
      w = clampN(w, 1, 100, 30);
      h = clampN(h, 1, 100, 20);
      out.elements.push({
        type: 'shape', shape: 'rect',
        // keep the shape on-canvas: x+width <= 100, y+height <= 100
        x: Math.min(clampN(e.x, 0, 100, 0), 100 - w),
        y: Math.min(clampN(e.y, 0, 100, 0), 100 - h),
        width: w, height: h,
        color: hex(e.color, '#3b82f6'), opacity: clampN(e.opacity, 0, 1, 0.85), radius: 0,
      });
    }
  }
  return out;
}

// GET /api/ai/settings — workspace members (never returns the key)
router.get('/settings', (req, res) => {
  const row = db.prepare('SELECT base_url, model, image_base_url, image_model, api_key_enc FROM ai_settings WHERE workspace_id = ?').get(req.workspaceId);
  res.json({
    base_url: row ? row.base_url || '' : '',
    model: row ? row.model || '' : '',
    image_base_url: row ? row.image_base_url || '' : '',
    image_model: row ? row.image_model || '' : '',
    has_key: !!(row && row.api_key_enc),
    configured: !!(row && row.base_url && row.model),
  });
});

// PUT /api/ai/settings — workspace admin
router.put('/settings', (req, res) => {
  if (!isWorkspaceAdmin(req)) return res.status(403).json({ error: 'Workspace admin required' });
  const base_url = String(req.body && req.body.base_url || '').trim().replace(/\/+$/, '');
  const model = String(req.body && req.body.model || '').trim();
  const image_base_url = String(req.body && req.body.image_base_url || '').trim().replace(/\/+$/, '');
  const image_model = String(req.body && req.body.image_model || '').trim();
  if (base_url && !endpointAllowed(base_url)) return res.status(400).json({ error: 'Endpoint URL not allowed (private/internal addresses are blocked on this instance).' });
  if (image_base_url && !endpointAllowed(image_base_url)) return res.status(400).json({ error: 'Image endpoint URL not allowed.' });

  const existing = db.prepare('SELECT api_key_enc FROM ai_settings WHERE workspace_id = ?').get(req.workspaceId);
  let api_key_enc = existing ? existing.api_key_enc : null;
  if (typeof (req.body && req.body.api_key) === 'string' && req.body.api_key.length) api_key_enc = encrypt(req.body.api_key);
  if (req.body && req.body.clear_key) api_key_enc = null;

  db.prepare(`
    INSERT INTO ai_settings (workspace_id, base_url, api_key_enc, model, image_base_url, image_model, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(workspace_id) DO UPDATE SET base_url=excluded.base_url, api_key_enc=excluded.api_key_enc,
      model=excluded.model, image_base_url=excluded.image_base_url, image_model=excluded.image_model, updated_at=excluded.updated_at
  `).run(req.workspaceId, base_url || null, api_key_enc, model || null, image_base_url || null, image_model || null);
  logActivity(req.user.id, 'ai_settings_update', `endpoint: ${base_url || '(none)'} model: ${model || '(none)'}`, null, getClientIp(req), req.workspaceId);
  res.json({ ok: true });
});

// POST /api/ai/models — list the models the configured/entered endpoint offers,
// for the settings dropdown. Admin only. Uses the posted key, or the saved one.
router.post('/models', async (req, res) => {
  if (!isWorkspaceAdmin(req)) return res.status(403).json({ error: 'Workspace admin required' });
  const base_url = String(req.body && req.body.base_url || '').trim().replace(/\/+$/, '');
  if (!base_url) return res.status(400).json({ error: 'Endpoint base URL required' });
  if (!endpointAllowed(base_url)) return res.status(400).json({ error: 'Endpoint URL not allowed (private/internal addresses are blocked on this instance).' });
  let key = (req.body && typeof req.body.api_key === 'string' && req.body.api_key.length) ? req.body.api_key : null;
  if (!key) { const row = db.prepare('SELECT api_key_enc FROM ai_settings WHERE workspace_id = ?').get(req.workspaceId); key = (row && decrypt(row.api_key_enc)) || 'none'; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let r;
  try {
    r = await fetch(base_url + '/models', { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    return res.status(502).json({ error: 'Could not reach the endpoint: ' + (e.name === 'AbortError' ? 'timed out' : e.message) });
  }
  clearTimeout(timer);
  if (!r.ok) { const t = await r.text().catch(() => ''); return res.status(502).json({ error: `Endpoint error ${r.status}: ${t.slice(0, 120)}` }); }
  let j; try { j = await r.json(); } catch { return res.status(502).json({ error: 'Endpoint returned non-JSON.' }); }
  const models = Array.isArray(j && j.data) ? j.data.map(m => m && m.id).filter(Boolean) : [];
  res.json({ models: models.slice(0, 300) });
});

// POST /api/ai/generate-design — editor+; proxies the workspace's endpoint
router.post('/generate-design', async (req, res) => {
  if (!canEdit(req)) return res.status(403).json({ error: 'Editor access required' });
  const prompt = String(req.body && req.body.prompt || '').trim().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const row = db.prepare('SELECT base_url, api_key_enc, model FROM ai_settings WHERE workspace_id = ?').get(req.workspaceId);
  if (!row || !row.base_url || !row.model) return res.status(400).json({ error: 'AI is not configured. Set an endpoint and model in AI settings first.' });
  if (!endpointAllowed(row.base_url)) return res.status(400).json({ error: 'Configured endpoint is not allowed.' });

  const key = decrypt(row.api_key_enc) || 'none';
  const url = row.base_url.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000); // local models can be slow
  let aiRes;
  try {
    aiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: row.model, temperature: 0.6, stream: false,
        messages: [{ role: 'system', content: DESIGN_SYSTEM_PROMPT }, { role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return res.status(502).json({ error: 'Could not reach the AI endpoint: ' + (e.name === 'AbortError' ? 'timed out' : e.message) });
  }
  clearTimeout(timer);
  if (!aiRes.ok) {
    const t = await aiRes.text().catch(() => '');
    return res.status(502).json({ error: `AI endpoint error ${aiRes.status}: ${t.slice(0, 150)}` });
  }
  let json;
  try { json = await aiRes.json(); } catch { return res.status(502).json({ error: 'AI returned non-JSON.' }); }
  const content = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  let parsed;
  try {
    const m = content.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : content);
  } catch { return res.status(502).json({ error: 'AI did not return a usable design. Try rephrasing.' }); }
  const design = normalizeDesign(parsed);
  if (!design.elements.length) return res.status(502).json({ error: 'AI returned an empty design. Try a more specific prompt.' });
  logActivity(req.user.id, 'ai_generate_design', `prompt: ${prompt.slice(0, 80)}`, null, getClientIp(req), req.workspaceId);
  res.json(design);
});

module.exports = router;
// Exposed for unit tests (security-critical: untrusted-LLM-output normalization
// and the SSRF guard).
module.exports.normalizeDesign = normalizeDesign;
module.exports.endpointAllowed = endpointAllowed;
