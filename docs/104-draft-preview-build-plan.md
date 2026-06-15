# #104 — Draft-aware, device-free preview via player reuse — BUILD PLAN

Status: **for review, not yet built.** Branch `investigate/preview-breakage-104` off `main`. No prod.

Backed by the investigation: the player already renders every item type correctly (YT.Player handshake, widget iframes); the failures were preview-specific. Reusing the player's renderer inherits its correctness for everything **except** webpage widgets pointing at frame-denying sites — which no in-browser surface can embed, and which (proven empirically + spec) **cannot be auto-detected client-side**. Hence: reuse the renderer, add an always-visible honest note for webpage widgets.

## Goals / non-goals

**Goal:** one preview surface that renders a *draft* playlist exactly as a device would, in a same-origin iframe in the dashboard — fixing "not all items load" (one renderer, full type union) and YouTube correctness, and telling the truth about un-embeddable webpage widgets.

**Non-goals:** server-side page proxying; screenshots; auto-detecting XFO refusal (proven impossible client-side); changing how devices render. The **renderer is untouched** — confirmed: `handlePlaylistUpdate(data)` is pure on `data`, every `socket.emit` is `socket?.connected`-guarded.

---

## Work item 1 — Server: `assemblePayload` refactor + preview endpoint

### 1a. Factor the payload tail out of `buildPlaylistPayload` (anti-drift)
`server/ws/deviceSocket.js:77-173`. Today `buildPlaylistPayload(deviceId)` does two things: (a) resolve device-bound fields, then (b) the **zone-reset + shape** tail (`:162-172` — strips `zone_id` when `zones.length < 2`, builds `{assignments, layout, orientation, wall_config, timezone}`).

Extract (b) into a pure function so device and preview can't drift:
```js
// deviceSocket.js
function assemblePayload({ assignments, layout, orientation, wall_config, timezone }) {
  const zoneCount = layout?.zones?.length || 0;
  let a = Array.isArray(assignments) ? assignments : [];
  if (zoneCount < 2) a = a.map(x => (x && x.zone_id != null ? { ...x, zone_id: null } : x));
  return { assignments: a, layout: layout || null, orientation: orientation || 'landscape',
           wall_config: wall_config || null, timezone: timezone || null };
}
module.exports.assemblePayload = assemblePayload;
```
`buildPlaylistPayload` keeps its device-field resolution and returns `assemblePayload({...})` at the end. **No behavior change for devices** — pure refactor; the existing device snapshot tests must stay green (that's the regression guard).

### 1b. `GET /api/playlists/:id/preview-payload`
`server/routes/playlists.js`. JWT-gated + workspace-scoped via the **existing** `requirePlaylistRead` (`:56`, `loadPlaylistAccess(req,res,false)`):
```js
router.get('/:id/preview-payload', requirePlaylistRead, (req, res) => {
  const { assemblePayload } = require('../ws/deviceSocket');
  const assignments = buildSnapshotItems(req.params.id);          // DRAFT-aware: live items, confirmed clean
  const layout = derivePreviewLayout(assignments);                // see Work item 2
  res.json(assemblePayload({
    assignments, layout,
    orientation: req.query.orientation || 'landscape',            // optional toggle (validated)
    wall_config: null,                                            // preview is single-screen
    timezone: null,                                               // browser clock
  }));
});
```
- `buildSnapshotItems` (`:67-89`) reads live `playlist_items`, never `published_snapshot` — works on a draft with zero special-casing. Confirmed: `published_snapshot === JSON.stringify(buildSnapshotItems(id))`, so preview ⇄ device shapes are identical by construction.
- Validate `orientation` against the renderer's set `{landscape, portrait, landscape-flipped, portrait-flipped}` (`index.html:1056`); default `landscape` on anything else.

---

## Work item 2 — Layout source (the one real design choice)

`playlists` has **no** `layout_id` (confirmed — layout is device-bound only). Derive the preview layout from the playlist's own zone-bound items via the FK chain `playlist_items.zone_id → layout_zones.id → layout_zones.layout_id`:

```js
function derivePreviewLayout(assignments) {
  const zoneIds = [...new Set(assignments.map(a => a.zone_id).filter(Boolean))];
  if (zoneIds.length === 0) return null;                          // 0 zoned -> fullscreen
  const rows = db.prepare(
    `SELECT DISTINCT layout_id FROM layout_zones WHERE id IN (${zoneIds.map(()=>'?').join(',')})`
  ).all(...zoneIds);
  if (rows.length === 0) return null;                             // dangling zones -> fullscreen
  // 1 -> that layout; >1 (rare/legacy) -> pick the one covering the MOST items, never crash
  let layoutId = rows[0].layout_id;
  let ambiguous = false;
  if (rows.length > 1) {
    ambiguous = true;
    const z2l = new Map();
    for (const r of db.prepare(`SELECT id, layout_id FROM layout_zones WHERE id IN (${zoneIds.map(()=>'?').join(',')})`).all(...zoneIds)) z2l.set(r.id, r.layout_id);
    const tally = {};
    for (const a of assignments) { const l = z2l.get(a.zone_id); if (l) tally[l] = (tally[l]||0)+1; }
    layoutId = Object.entries(tally).sort((x,y)=>y[1]-x[1])[0][0];
  }
  const layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(layoutId);
  if (!layout) return null;
  layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layoutId);
  if (ambiguous) layout._preview_ambiguous = true;               // dashboard shows "previewing layout <name>"
  return layout;
}
```
- **0 zoned → fullscreen**, **1 → use it**, **>1 distinct → dominant + `_preview_ambiguous` flag** so the dashboard can caption "Previewing layout: <name>". Must not crash — covered.
- `orientation` → default landscape + optional toggle (Work item 5). `wall_config` → null. `timezone` → null (dayparting previews in the previewer's local clock; document this, it's expected not a bug).

---

## Work item 3 — Player: preview bootstrap branch (renderer untouched)

`server/player/index.html`. Today boot is: DOMContentLoaded (`:278`) → if `serverUrl && deviceId && paired` → `connect()` (`:523/557`) → socket `register()` (`:653`). Add a branch that runs **before** that when `?preview=1` is present, and never touches pairing/socket:

```js
// near the DOMContentLoaded entry (~:278), before the paired/connect path
const qs = new URLSearchParams(location.search);
if (qs.get('preview') === '1' && qs.get('playlist')) {
  return bootPreview(qs.get('playlist'), qs.get('orientation'));
}
```
```js
async function bootPreview(playlistId, orientation) {
  config.serverUrl = window.location.origin;                     // same-origin -> /uploads, /api/widgets resolve
  const token = localStorage.getItem('token');                  // same-origin: shares dashboard's Bearer token (api.js:4)
  const url = `/api/playlists/${playlistId}/preview-payload` + (orientation ? `?orientation=${encodeURIComponent(orientation)}` : '');
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) { showPreviewError(res.status); return; }
  const payload = await res.json();
  PREVIEW_MODE = true;                                           // gate: enables webpage note, disables proof-of-play/socket paths (already guarded)
  handlePlaylistUpdate(payload);                                 // UNTOUCHED renderer entry
}
```
- `socket` stays `undefined`; all `socket?.connected` emits (heartbeat `:867`, proof-of-play `:1193/1212`, wall-sync) no-op. The wall branch (`:1078`) needs `wallConfig` truthy → never entered (`wall_config:null`). Safe.
- `PREVIEW_MODE` is the single new global; used only by Work item 4 (the note) and to skip device-only UI (pairing screen, audio-unlock gestures optional).
- Auth note: `localStorage` is per-origin, and `/player` is same-origin as the dashboard, so the token is readable. (If we later want the player on a separate origin, switch to a short-lived scoped token in the iframe URL — out of scope now.)

---

## Work item 4 — Webpage-widget honest note (always visible, no detection)

Where the player renders a widget item (`index.html:1514-1523` fullscreen, `:1598-1625` zones), when `PREVIEW_MODE && item.widget_type === 'webpage'`, wrap the widget iframe with a persistent caption overlay (the assignment already carries `widget_type` from `buildSnapshotItems`):
```
<div class="preview-webpage-note">{{ t('preview.webpage_blocked_note') }}</div>
```
Caption text: **"If this area is blank, the site blocks embedding in a browser — it will still display on the device screen."** Styled as a small, non-blocking footer band over the iframe (never covers the content). Shown **only** in `PREVIEW_MODE` → never appears on real devices/Android.

**i18n:** add `preview.webpage_blocked_note` to all locale files — `frontend/js/i18n/{en,es,fr,de,it,pt}.js` (en + 5 translations).

> **Reviewer decision:** the *original* ImpactMaster "refused the connection" report was the **widget preview modal** (`frontend/js/views/widgets.js:108-132`), a separate surface from this new player preview. Recommend applying the same caption there too (one-line add) so the actually-reported symptom is closed. Flagging rather than assuming.

---

## Work item 5 — Dashboard preview surface + orientation toggle

- Add the preview trigger (button) on the playlist detail view (`frontend/js/views/playlists.js`) that opens a same-origin iframe `<iframe src="/player?preview=1&playlist=<id>">`. Same-origin → dashboard CSP `frame-src 'self'` (`server/server.js:65-86`) already permits it; no CSP change.
- **Orientation toggle:** a landscape/portrait control in the preview chrome that reloads the iframe with `&orientation=portrait`. Cheap — the server passes it through and the renderer already applies rotation/viewport (`index.html:1055-1062`).
- If `layout._preview_ambiguous`, show "Previewing layout: <name>" caption (from Work item 2).

**Second pass (scope separately if it balloons):** skip / fast-forward controls. The real player has no such controls (it's device-driven), so these are net-new player UI (prev/next item, pause). Keep out of the core build; ship the faithful preview first.

---

## Auth & security
- Endpoint: `requirePlaylistRead` → workspace-scoped, JWT-gated (same as `GET /api/playlists/:id`). A user can only preview playlists they can read.
- No new external surface, no proxy, no SSRF. Webpage widgets still render via the existing `/api/widgets/:id/render` (X-Frame-Options already dropped there for the player, `widgets.js:191`); browser still enforces the *inner* site's XFO — which is exactly why the note exists.
- Content (`/uploads`) loads via bare `<img/video src>` same-origin (already how the device player loads it) — confirm `/uploads/content` is publicly readable (it is for the device player; low risk).

## Test plan
1. **Refactor guard:** existing device snapshot/payload tests stay green (proves `assemblePayload` didn't change device behavior).
2. **Endpoint:** draft playlist with (a) no zones, (b) one-zone-layout, (c) multi-zone layout, (d) items spanning 2 layouts → assert layout derivation + payload shape == device payload for the same items after publish.
3. **Player preview:** image, video, `video/youtube`, each widget type incl. webpage → render in the iframe; YouTube plays via YT.Player; webpage widget shows the note.
4. **Auth:** preview-payload returns 401/403 without a valid token / for a playlist outside the workspace.
5. **No-socket safety:** confirm no console errors from socket emits in preview (all guarded).

## Files touched (core)
- `server/ws/deviceSocket.js` — extract `assemblePayload` (pure refactor).
- `server/routes/playlists.js` — `GET /:id/preview-payload` + `derivePreviewLayout`.
- `server/player/index.html` — `bootPreview` branch + `PREVIEW_MODE` + webpage note wrapper.
- `frontend/js/views/playlists.js` — preview button + iframe + orientation toggle.
- `frontend/js/i18n/{en,es,fr,de,it,pt}.js` — `preview.webpage_blocked_note` (+ "previewing layout" string).
- (reviewer-decision) `frontend/js/views/widgets.js` — same note on the existing widget preview modal.

## Risk register
- **Layout >1-distinct ambiguity** — handled (dominant + caption), can't crash. Lowest-likelihood path.
- **`/uploads` auth** — verify public-readable (expected). If token-gated, content needs a same-origin cookie or signed URL (would also affect device player — so it isn't).
- **Renderer drift** — mitigated by `assemblePayload` being the single shared shape source + the refactor regression test.
- **i18n completeness** — 6 locale files; missing a key falls back to en (acceptable) but add all 6.
