'use strict';

// #146 — unit coverage for the two new primitives behind the /api/status changes.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-obsunit-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const heartbeat = require('../services/heartbeat');
const appSettings = require('../lib/app-settings');

test('heartbeat.getConnectedCount reflects the live connection map (not DB status)', () => {
  const start = heartbeat.getConnectedCount();
  heartbeat.registerConnection('dev-a', 'sock-a');
  heartbeat.registerConnection('dev-b', 'sock-b');
  assert.equal(heartbeat.getConnectedCount(), start + 2, 'count rises with registered sockets');
  heartbeat.removeConnection('dev-a');
  assert.equal(heartbeat.getConnectedCount(), start + 1, 'count falls when a socket leaves');
  heartbeat.removeConnection('dev-b');
  assert.equal(heartbeat.getConnectedCount(), start);
});

test('app-settings: env default until set, then persisted value overrides (cached)', () => {
  assert.equal(appSettings.getBool('status_debug_enabled', true), true, 'falls back to env default when unset');
  assert.equal(appSettings.getBool('status_debug_enabled', false), false, 'default honored when unset');
  appSettings.setBool('status_debug_enabled', false);
  assert.equal(appSettings.getBool('status_debug_enabled', true), false, 'persisted false overrides the (true) default');
  appSettings.setBool('status_debug_enabled', true);
  assert.equal(appSettings.getBool('status_debug_enabled', false), true, 'persisted true overrides the (false) default');
});
