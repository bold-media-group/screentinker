'use strict';

// #142 (cut 2) — provisioning-row cleanup window correctness. The sweep deletes
// UNCLAIMED provisioning devices older than 24h (it previously used 365*86400 — a
// year — contradicting its own comment). Imported devices (user_id set) and
// non-provisioning devices are preserved. Deterministic, in-process (no server).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-provclean-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { pruneProvisioningDevices } = require('../services/heartbeat');

test('sweeps unclaimed provisioning devices older than 24h, keeps the rest', () => {
  db.pragma('foreign_keys = OFF'); // seed user_id without a real users row
  db.exec('DELETE FROM devices');
  const ins = db.prepare("INSERT INTO devices (id, status, user_id, created_at) VALUES (?, ?, ?, strftime('%s','now') - ?)");
  ins.run('old-unclaimed', 'provisioning', null, 25 * 3600);   // >24h, unclaimed  -> SWEPT
  ins.run('new-unclaimed', 'provisioning', null, 1 * 3600);    // <24h, unclaimed  -> kept
  ins.run('old-imported', 'provisioning', 'u-imported', 25 * 3600); // >24h but imported (user_id) -> kept
  ins.run('old-online', 'online', null, 25 * 3600);           // >24h but not provisioning -> kept
  db.pragma('foreign_keys = ON');

  assert.equal(db.prepare('SELECT COUNT(*) c FROM devices').get().c, 4, 'seeded 4');

  const deleted = pruneProvisioningDevices();
  assert.equal(deleted, 1, 'only the >24h unclaimed provisioning device is swept');

  const ids = db.prepare('SELECT id FROM devices ORDER BY id').all().map(r => r.id);
  assert.deepEqual(ids, ['new-unclaimed', 'old-imported', 'old-online']);
  // regression guard: a 25h-old row sits well inside the OLD 365-day window, so this
  // would have survived before the fix.
});

test('idempotent: a second sweep with nothing stale deletes nothing', () => {
  assert.equal(pruneProvisioningDevices(), 0);
});
