'use strict';

// #73: GET /api/agency/playlists is a new READ surface on the security primitive, so prove
// it confines with write-path rigor. The query (lib/agency-targets.js) must return ONLY this
// token's designated, in-workspace playlists. Four ways it could leak, all asserted here;
// neutralizing the t.token_id filter makes it go red (the bite).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { listDesignatedPlaylists } = require('../lib/agency-targets');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE api_token_targets (token_id TEXT, playlist_id TEXT, PRIMARY KEY(token_id, playlist_id));
  CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT, status TEXT, workspace_id TEXT);
  INSERT INTO playlists (id, name, status, workspace_id) VALUES
    ('p1','One',  'published','wsA'),
    ('p2','Two',  'published','wsA'),
    ('p3','Three','published','wsA'),
    ('pX','Cross','published','wsB');
  INSERT INTO api_token_targets (token_id, playlist_id) VALUES
    ('tokA','p1'),   -- own + in-workspace  -> MUST appear
    ('tokA','pX'),   -- own but CROSS-workspace -> must NOT appear
    ('tokB','p2');   -- ANOTHER token's     -> must NOT appear for tokA
  -- p3 is in wsA but designated to no one -> OUTSIDE the allowlist -> must NOT appear
`);

test('#73 GET targets: returns ONLY this token\'s designated, in-workspace playlists', () => {
  const a = listDesignatedPlaylists(db, 'tokA', 'wsA').map(r => r.id);
  assert.deepEqual(a, ['p1'],
    'tokA sees ONLY p1 - not p2 (another token), not p3 (outside allowlist), not pX (cross-workspace)');
  const b = listDesignatedPlaylists(db, 'tokB', 'wsA').map(r => r.id);
  assert.deepEqual(b, ['p2'], 'tokB sees ONLY p2');
});
