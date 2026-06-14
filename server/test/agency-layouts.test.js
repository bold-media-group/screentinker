'use strict';

// #73: GET /api/agency/layouts is a read surface on the primitive, so prove it confines with
// the same rigor as the playlists list. The query (lib/agency-layouts.js) is DEVICE-FREE:
// designated playlist -> item zone -> layout. Asserted: own layout YES, a non-designated
// playlist's layout NO, and the response carries NO device fields (structurally absent - the
// device row exists in the db but is never queried). Neutralizing the t.token_id filter -> red.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { listLayoutGeometry } = require('../lib/agency-layouts');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE api_token_targets (token_id TEXT, playlist_id TEXT);
  CREATE TABLE playlists (id TEXT, workspace_id TEXT);
  CREATE TABLE playlist_items (id INTEGER PRIMARY KEY, playlist_id TEXT, zone_id TEXT);
  CREATE TABLE layouts (id TEXT, name TEXT, width INTEGER, height INTEGER);
  CREATE TABLE layout_zones (id TEXT, layout_id TEXT, name TEXT, x_percent REAL, y_percent REAL,
    width_percent REAL, height_percent REAL, z_index INTEGER, zone_type TEXT, fit_mode TEXT,
    background_color TEXT, sort_order INTEGER);
  CREATE TABLE devices (id TEXT, name TEXT, layout_id TEXT, playlist_id TEXT, ip_address TEXT);
  INSERT INTO layouts VALUES ('L1','Lobby',1920,1080), ('L2','Cafe',1080,1920);
  INSERT INTO layout_zones VALUES
    ('z1','L1','Main',0,0,70,100,0,'content','contain','#000000',0),
    ('z2','L1','Sidebar',70,0,30,100,1,'content','contain','#111111',1),
    ('z3','L2','Full',0,0,100,100,0,'content','cover','#000000',0);
  INSERT INTO playlists VALUES ('plA','wsA'), ('plB','wsA');
  INSERT INTO playlist_items VALUES (1,'plA','z1'), (2,'plB','z3');
  INSERT INTO api_token_targets VALUES ('tokA','plA'), ('tokB','plB');
  -- a device referencing L1/plA with a location-y name + IP. The device-free query must
  -- NEVER surface any of this.
  INSERT INTO devices VALUES ('d1','Lobby Screen — North Wall','L1','plA','10.0.0.5');
`);

test('#73 layout geometry: own layout only, all zones geometry, theirs marked, NO device data', () => {
  const a = listLayoutGeometry(db, 'tokA', 'wsA');
  assert.equal(a.length, 1, 'tokA sees ONLY L1 (its designated playlist feeds it), not L2');
  assert.equal(a[0].id, 'L1');
  assert.deepEqual({ name: a[0].name, width: a[0].width, height: a[0].height }, { name: 'Lobby', width: 1920, height: 1080 });
  assert.deepEqual(a[0].zones.map(z => z.id), ['z1', 'z2'], 'all zones of the canvas (geometry), incl. the sibling');
  assert.deepEqual(a[0].feeds_zone_ids, ['z1'], 'only z1 is marked as this token\'s zone (z2 is geometry only)');

  // NO device data anywhere in the response - structurally absent (the device row exists).
  const blob = JSON.stringify(a);
  for (const leak of ['d1', 'North Wall', '10.0.0.5', 'ip_address', 'device']) {
    assert.ok(!blob.includes(leak), `response must not contain "${leak}"`);
  }
  // zone objects expose only geometry keys, nothing fleet.
  assert.deepEqual(Object.keys(a[0].zones[0]).sort(),
    ['background_color', 'fit_mode', 'height_percent', 'id', 'name', 'sort_order', 'width_percent', 'x_percent', 'y_percent', 'z_index', 'zone_type'].sort());

  assert.deepEqual(listLayoutGeometry(db, 'tokB', 'wsA').map(l => l.id), ['L2'], 'tokB sees ONLY L2');
});
