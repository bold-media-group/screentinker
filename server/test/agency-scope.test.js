'use strict';

// #73 SPINE: an 'agency' scope is OFF the read/write/full ladder, so the EXISTING
// tokenScopeGate rejects it on every router by construction (auto-confinement). This is
// the foundation the whole model rests on - prove it before building anything on top.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// tokenScopeGate is pure (no db), but requiring the module loads db/database - inject one.
require.cache[require.resolve('../db/database')] = {
  id: require.resolve('../db/database'), loaded: true, exports: { db: new Database(':memory:') },
};
const { tokenScopeGate } = require('../middleware/apiToken');

function run(scope, method) {
  const req = { viaToken: true, tokenScope: scope, method };
  let status = 200, nexted = false;
  const res = { status(s) { status = s; return this; }, json() { return this; } };
  tokenScopeGate(req, res, () => { nexted = true; });
  return { status, nexted };
}

test('#73 spine: agency scope auto-fails tokenScopeGate everywhere (off-ladder)', () => {
  assert.equal(run('agency', 'GET').status, 403, 'agency cannot read on a normal router');
  assert.equal(run('agency', 'POST').status, 403, 'agency cannot write on a normal router');
  assert.equal(run('agency', 'GET').nexted, false, 'agency never reaches the handler');
  // Contrast: normal scopes still pass - the gate isn't just rejecting everything.
  assert.equal(run('write', 'POST').nexted, true, 'write still passes write');
  assert.equal(run('read', 'GET').nexted, true, 'read still passes read');
});
