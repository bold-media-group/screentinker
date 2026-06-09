'use strict';

// #37: verifyAndRepairSchema - repairs missing repairable columns, and reports
// (fail-fast hook) anything still missing. We inject onMissing so the fail path
// doesn't call process.exit during tests. Node v20 built-ins only.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { verifyAndRepairSchema, REQUIRED_TABLES } = require('../lib/schema-check');

function freshDb(withMustChange = true) {
  const db = new Database(':memory:');
  for (const t of REQUIRED_TABLES) {
    if (t === 'users') {
      db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, plan_id TEXT${withMustChange ? ', must_change_password INTEGER NOT NULL DEFAULT 0' : ''})`);
    } else {
      db.exec(`CREATE TABLE ${t} (id TEXT PRIMARY KEY)`);
    }
  }
  return db;
}
const hasCol = (db, t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);

test('healthy schema: nothing missing, onMissing not called', () => {
  const db = freshDb(true);
  let called = false;
  const missing = verifyAndRepairSchema(db, { onMissing: () => { called = true; } });
  assert.deepEqual(missing, []);
  assert.equal(called, false);
});

test('missing repairable column (must_change_password) is auto-repaired - no fail', () => {
  const db = freshDb(false);
  assert.equal(hasCol(db, 'users', 'must_change_password'), false, 'precondition: column absent');
  let called = false;
  const missing = verifyAndRepairSchema(db, { onMissing: () => { called = true; } });
  assert.deepEqual(missing, [], 'no residual missing after repair');
  assert.equal(called, false, 'onMissing not called when repair succeeds');
  assert.equal(hasCol(db, 'users', 'must_change_password'), true, 'column was added');
});

test('missing required table -> reported to onMissing (fail-fast hook fires)', () => {
  const db = freshDb(true);
  db.exec('DROP TABLE activity_log');
  let got = null;
  verifyAndRepairSchema(db, { onMissing: (m) => { got = m; } });
  assert.ok(got && got.some(x => /activity_log/.test(x)), 'reported the missing table');
});
