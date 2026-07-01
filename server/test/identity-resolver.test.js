'use strict';

// #146 P1.1 — resolveIdentity() runs on EVERY register. It must SHORT-CIRCUIT on
// device_id (the common case) and query device_fingerprints ONLY when device_id is
// absent — zero extra DB lookups for a device that sends its id.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-ident-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { resolveIdentity } = require('../lib/device-identity');

// Spy on db.prepare to record whether the device_fingerprints query is ever prepared/run.
function withPrepareSpy(fn) {
  const real = db.prepare.bind(db);
  const prepared = [];
  db.prepare = (sql) => { prepared.push(sql); return real(sql); };
  try { fn(); } finally { db.prepare = real; }
  return prepared;
}

test('a device_id-present resolve does ZERO fingerprint lookups', () => {
  // warm the memoized statement first so a lazy prepare doesn't confuse the spy
  resolveIdentity({ fingerprint: 'warm' });
  const prepared = withPrepareSpy(() => {
    const r = resolveIdentity({ device_id: 'dev-1', fingerprint: 'fp', device_token: 'tok' });
    assert.equal(r.kind, 'device_id');
    assert.equal(r.deviceId, 'dev-1');
  });
  assert.equal(prepared.filter((s) => /device_fingerprints/.test(s)).length, 0,
    'no device_fingerprints query when device_id is present');
});

test('a device_id-absent resolve DOES query device_fingerprints (only then)', () => {
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT OR REPLACE INTO device_fingerprints (fingerprint, device_id) VALUES ('fp-x', 'dev-x')").run();
  db.pragma('foreign_keys = ON');
  const r = resolveIdentity({ fingerprint: 'fp-x' });
  assert.equal(r.kind, 'fingerprint->device_id');
  assert.equal(r.deviceId, 'dev-x');
});
