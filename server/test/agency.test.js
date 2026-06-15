'use strict';

// #73 FULL bite-suite for the agency-token primitive, end-to-end against a booted server:
// the happy path (upload -> date-bounded item on a DESIGNATED playlist) plus the four
// confinement assertions at their three seams (gate / off-ladder / JWT-only / issuance).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const PORT = 3992;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), 'st-agency-' + crypto.randomBytes(4).toString('hex'));
let proc;

before(async () => {
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-agency.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) break; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } });

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const jpost = (tok, o) => ({ method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
const reg = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

test('#73 agency token: full bite-suite (happy path + 4 confinement assertions)', async () => {
  const email = 'ag' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const jwt = (await jfetch('/api/auth/register', reg({ email, password: 'Passw0rd123' }))).body.token;
  const pl1 = (await jfetch('/api/playlists', jpost(jwt, { name: 'Designated' }))).body;
  const pl2 = (await jfetch('/api/playlists', jpost(jwt, { name: 'Off-limits' }))).body;

  // issue an agency token bound to pl1 ONLY
  const tokRes = await jfetch('/api/tokens', jpost(jwt, { name: 'Agency', scope: 'agency', target_playlist_ids: [pl1.id] }));
  assert.equal(tokRes.status, 201, 'agency token created');
  assert.deepEqual(tokRes.body.target_playlist_ids, [pl1.id]);
  const atok = tokRes.body.token;

  // GET targets (real path: agencyGate -> handler -> query): returns ONLY the designated pl1
  const mine = await jfetch('/api/agency/playlists', { headers: { Authorization: 'Bearer ' + atok } });
  assert.equal(mine.status, 200, 'agency can list its targets');
  assert.deepEqual(mine.body.map(p => p.id), [pl1.id], 'GET /agency/playlists returns ONLY the designated playlist (not pl2)');

  // GET per-playlist layout (real path through router.param): 200 + array, never device fields;
  // a NON-designated playlist's layout -> 403 (router.param confines it)
  const lay = await jfetch(`/api/agency/playlists/${pl1.id}/layout`, { headers: { Authorization: 'Bearer ' + atok } });
  assert.equal(lay.status, 200, 'agency can read its designated playlist layout');
  assert.ok(Array.isArray(lay.body), 'layout is an array');
  assert.ok(!JSON.stringify(lay.body).includes('device'), 'layout response carries no device data');
  const layX = await jfetch(`/api/agency/playlists/${pl2.id}/layout`, { headers: { Authorization: 'Bearer ' + atok } });
  assert.equal(layX.status, 403, 'layout of a NON-designated playlist -> 403 (router.param)');

  // HAPPY PATH: upload via the agency token (shared ingest -> first-class content)
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('x')], { type: 'image/png' }), 't.png');
  const up = await fetch(BASE + '/api/agency/content', { method: 'POST', headers: { Authorization: 'Bearer ' + atok }, body: fd });
  assert.equal(up.status, 201, 'agency upload -> 201 (first-class content)');
  const content = await up.json();

  // date-bounded item on the DESIGNATED playlist
  const item = await jfetch(`/api/agency/playlists/${pl1.id}/items`, jpost(atok, { content_id: content.id, start_date: '2026-07-01', end_date: '2026-07-31' }));
  assert.equal(item.status, 201, 'item on designated playlist -> 201');

  // BITE 1 (gate): NON-designated playlist -> 403
  const blocked = await jfetch(`/api/agency/playlists/${pl2.id}/items`, jpost(atok, { content_id: content.id }));
  assert.equal(blocked.status, 403, 'non-designated playlist -> 403');

  // BITE 2 (off-ladder): agency token on a normal public router -> 403
  const dev = await jfetch('/api/devices', { headers: { Authorization: 'Bearer ' + atok } });
  assert.equal(dev.status, 403, 'agency token on /api/devices -> 403 (off-ladder, tokenScopeGate)');

  // BITE 3 (JWT-only): can't reach /api/tokens to widen its OWN targets -> 401
  const widen = await jfetch(`/api/tokens/${tokRes.body.id}/targets`, jpost(atok, { target_playlist_ids: [pl1.id, pl2.id] }));
  assert.equal(widen.status, 401, 'agency token cannot reach /api/tokens (JWT-only) -> 401');

  // BITE 4 (issuance): an agency token can't be BOUND to an out-of-workspace/unknown playlist -> 400
  const badTok = await jfetch('/api/tokens', jpost(jwt, { name: 'Bad', scope: 'agency', target_playlist_ids: ['nonexistent'] }));
  assert.equal(badTok.status, 400, 'cannot bind an out-of-workspace target at issuance');

  // Portal graceful-failure trigger: an invalid/revoked key -> 401, which the portal catches
  // to show "paste it again" (never a wall of 403s).
  const bogus = await jfetch('/api/agency/playlists', { headers: { Authorization: 'Bearer st_bogus_invalid_key' } });
  assert.equal(bogus.status, 401, 'invalid agency key -> 401 (portal resets to the entry screen)');
});

test('#73 auto-publish: the TOKEN flag decides draft vs live; the body can never override it', async () => {
  const jwtAuth = (tok) => ({ headers: { Authorization: 'Bearer ' + tok } });
  const email = 'ap' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const jwt = (await jfetch('/api/auth/register', reg({ email, password: 'Passw0rd123' }))).body.token;
  const plD = (await jfetch('/api/playlists', jpost(jwt, { name: 'DraftTarget' }))).body;
  const plA = (await jfetch('/api/playlists', jpost(jwt, { name: 'AutoTarget' }))).body;

  const draftTok = (await jfetch('/api/tokens', jpost(jwt, { name: 'DraftAgency', scope: 'agency', target_playlist_ids: [plD.id] }))).body;
  assert.equal(draftTok.auto_publish, false, 'DEFAULT is draft (auto_publish false) - the fail-safe');
  const autoTok = (await jfetch('/api/tokens', jpost(jwt, { name: 'AutoAgency', scope: 'agency', target_playlist_ids: [plA.id], auto_publish: true }))).body;
  assert.equal(autoTok.auto_publish, true, 'admin explicitly opted into auto-publish');

  async function upload(tok) {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('x')], { type: 'image/png' }), 't.png');
    return (await fetch(BASE + '/api/agency/content', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd })).json();
  }
  const cD = await upload(draftTok.token);
  const cA = await upload(autoTok.token);

  // (a) DRAFT token + {auto_publish:true} IN THE BODY -> still draft (token flag wins, body ignored)
  const addD = await jfetch(`/api/agency/playlists/${plD.id}/items`, jpost(draftTok.token, { content_id: cD.id, auto_publish: true }));
  assert.equal(addD.status, 201);
  assert.equal(addD.body.published, false, 'draft token does NOT publish even with auto_publish:true in the body');
  assert.equal((await jfetch(`/api/playlists/${plD.id}`, jwtAuth(jwt))).body.status, 'draft', 'playlist stays draft');

  // (b) AUTO-PUBLISH token -> item goes live via the shared publishPlaylist path
  const addA = await jfetch(`/api/agency/playlists/${plA.id}/items`, jpost(autoTok.token, { content_id: cA.id }));
  assert.equal(addA.status, 201);
  assert.equal(addA.body.published, true, 'auto-publish token publishes');
  assert.equal((await jfetch(`/api/playlists/${plA.id}`, jwtAuth(jwt))).body.status, 'published', 'playlist is published');

  // (c) REGRESSION: the manual publish endpoint still works after the publishPlaylist extraction
  const pub = await jfetch(`/api/playlists/${plD.id}/publish`, jpost(jwt, {}));
  assert.equal(pub.status, 200, 'manual publish works post-extraction');
  assert.equal((await jfetch(`/api/playlists/${plD.id}`, jwtAuth(jwt))).body.status, 'published', 'manual publish sets status=published');
});

test('#73 edit-designations: PUT /:id/targets re-designates (add + remove); confinement follows', async () => {
  const auth = (tok) => ({ headers: { Authorization: 'Bearer ' + tok } });
  const email = 're' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const jwt = (await jfetch('/api/auth/register', reg({ email, password: 'Passw0rd123' }))).body.token;
  const plA = (await jfetch('/api/playlists', jpost(jwt, { name: 'A' }))).body;
  const plB = (await jfetch('/api/playlists', jpost(jwt, { name: 'B' }))).body;
  const plC = (await jfetch('/api/playlists', jpost(jwt, { name: 'C' }))).body;

  const tokRes = await jfetch('/api/tokens', jpost(jwt, { name: 'EditMe', scope: 'agency', target_playlist_ids: [plA.id, plB.id] }));
  const atok = tokRes.body.token, tokId = tokRes.body.id;
  // initially A+B designated (200 = router.param lets it through), C not (403)
  assert.equal((await jfetch(`/api/agency/playlists/${plA.id}/layout`, auth(atok))).status, 200, 'A reachable');
  assert.equal((await jfetch(`/api/agency/playlists/${plC.id}/layout`, auth(atok))).status, 403, 'C not yet designated');

  // re-designate: drop A, keep B, add C
  const put = await jfetch(`/api/tokens/${tokId}/targets`, { method: 'PUT', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' }, body: JSON.stringify({ target_playlist_ids: [plB.id, plC.id] }) });
  assert.equal(put.status, 200, 're-designate ok');

  // confinement follows the NEW set: removed A -> 403, kept B -> 200, added C -> 200
  assert.equal((await jfetch(`/api/agency/playlists/${plA.id}/layout`, auth(atok))).status, 403, 'removed A -> 403');
  assert.equal((await jfetch(`/api/agency/playlists/${plB.id}/layout`, auth(atok))).status, 200, 'kept B -> 200');
  assert.equal((await jfetch(`/api/agency/playlists/${plC.id}/layout`, auth(atok))).status, 200, 'added C -> 200');
});

test('#73 full-screen guardrail holds at UPLOAD time too (auto-publish has no draft net)', async () => {
  const auth = (tok) => ({ headers: { Authorization: 'Bearer ' + tok } });
  const upload = async (tok) => {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('x')], { type: 'image/png' }), 't.png');
    return (await fetch(BASE + '/api/agency/content', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd })).json();
  };
  const email = 'fs' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const jwt = (await jfetch('/api/auth/register', reg({ email, password: 'Passw0rd123' }))).body.token;
  const plFS = (await jfetch('/api/playlists', jpost(jwt, { name: 'FullScreen' }))).body;

  // (1) full-screen playlist -> AUTO-PUBLISH token designation SUCCEEDS (safe at designation)
  const tokRes = await jfetch('/api/tokens', jpost(jwt, { name: 'AP', scope: 'agency', target_playlist_ids: [plFS.id], auto_publish: true }));
  assert.equal(tokRes.status, 201, 'full-screen designation OK');
  const atok = tokRes.body.token;

  // (2) zone the playlist AFTER designation: a layout+zone, then a zone-targeted item via JWT
  const lid = (await jfetch('/api/layouts', jpost(jwt, { name: 'Z', zones: [{ name: 'Main', x_percent: 0, y_percent: 0, width_percent: 70, height_percent: 100 }] }))).body.id;
  const zoneId = (await jfetch(`/api/layouts/${lid}`, auth(jwt))).body.zones[0].id;
  const c1 = await upload(atok);
  assert.equal((await jfetch(`/api/playlists/${plFS.id}/items`, jpost(jwt, { content_id: c1.id, zone_id: zoneId }))).status, 201, 'playlist is now zoned');

  // (3) THE BITE: agency upload to the now-zoned playlist is BLOCKED (409), NOT auto-published into the zone
  const c2 = await upload(atok);
  const add = await jfetch(`/api/agency/playlists/${plFS.id}/items`, jpost(atok, { content_id: c2.id }));
  assert.equal(add.status, 409, 'upload to a now-zoned playlist blocked (auto-publish cannot slip it into the zone)');

  // (4) and an already-zoned playlist is rejected at DESIGNATION too
  const reDesig = await jfetch('/api/tokens', jpost(jwt, { name: 'AP2', scope: 'agency', target_playlist_ids: [plFS.id] }));
  assert.equal(reDesig.status, 400, 'already-zoned playlist rejected at designation');
});
