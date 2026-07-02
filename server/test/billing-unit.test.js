'use strict';

// #146 BILLING — unit coverage: contract math, the accumulator, the Usage Report, and
// rollup retention. In-process (shares one DATA_DIR/db). Tests use DISTINCT months/device
// ids so month-scoped queries don't collide; retention runs LAST (it prunes old months).

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-billing-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const billing = require('../lib/billing');
const heartbeat = require('../services/heartbeat');

const seedRow = db.prepare('INSERT OR REPLACE INTO device_usage_daily (device_id, day, online_seconds) VALUES (?, ?, ?)');
const readSec = (id, day) => (db.prepare('SELECT online_seconds s FROM device_usage_daily WHERE device_id = ? AND day = ?').get(id, day) || {}).s;

// ---------------- contract math ----------------
test('ASD: 8h->1.0, 4h->0.5, 24h->1.0 (capped), 0->0', () => {
  assert.equal(billing.activeScreenDay(28800), 1.0);
  assert.equal(billing.activeScreenDay(14400), 0.5);
  assert.equal(billing.activeScreenDay(86400), 1.0);   // beyond 8h does NOT increase it
  assert.equal(billing.activeScreenDay(0), 0);
});

test('BillableScreens = round-half-up(Σ ASD / days)', () => {
  assert.equal(billing.billableScreens(70, 28), 3);    // 2.5 -> 3 (half up)
  assert.equal(billing.billableScreens(35, 10), 4);    // 3.5 -> 4 (half up)
  assert.equal(billing.billableScreens(69, 28), 2);    // 2.464 -> 2
  assert.equal(billing.billableScreens(31, 31), 1);
  assert.equal(billing.billableScreens(0, 31), 0);
});

test('tier is flat: 499->1.50, 500->1.25, 999->1.25, 1000->1.00; 0 unbilled', () => {
  const rate = (n) => billing.tierFor(n).rate;
  assert.equal(rate(1), 1.50);
  assert.equal(rate(499), 1.50);
  assert.equal(rate(500), 1.25);
  assert.equal(rate(999), 1.25);
  assert.equal(rate(1000), 1.00);
  assert.equal(rate(50000), 1.00);
  assert.equal(billing.tierFor(0), null);
  assert.equal(billing.tierLabel(300), '1-499');
  assert.equal(billing.tierLabel(700), '500-999');
  assert.equal(billing.tierLabel(5000), '1000+');
});

// ---------------- accumulator (uses January 2025 to avoid the report months) ----------------
test('accumulator: accrues by interval, caps at 86400/day, disconnected does not accrue', async () => {
  heartbeat.__resetAccrual();
  const A = 'acc-a', B = 'acc-b';
  heartbeat.registerConnection(A, 'sA');
  heartbeat.registerConnection(B, 'sB');
  const t0 = Date.UTC(2025, 0, 15, 12, 0, 0), day = '2025-01-15';
  assert.equal(await heartbeat.accrueUsage(t0), 0, 'first tick is baseline (no credit)');
  await heartbeat.accrueUsage(t0 + 10000);              // +10s to both connected devices
  assert.equal(readSec(A, day), 10);
  assert.equal(readSec(B, day), 10);

  heartbeat.removeConnection(B);                         // B goes offline
  await heartbeat.accrueUsage(t0 + 20000);              // +10s to A only
  assert.equal(readSec(A, day), 20, 'still-connected device accrues');
  assert.equal(readSec(B, day), 10, 'disconnected device does NOT accrue');
  heartbeat.removeConnection(A);
});

test('accumulator: daily online_seconds capped at 86400', async () => {
  heartbeat.__resetAccrual();
  const C = 'acc-cap', day = '2025-01-16';
  heartbeat.registerConnection(C, 'sC');
  await heartbeat.accrueUsage(Date.UTC(2025, 0, 16, 0, 0, 0));      // baseline
  seedRow.run(C, day, 86390);                                       // near the daily cap
  await heartbeat.accrueUsage(Date.UTC(2025, 0, 16, 0, 0, 20));     // +20s -> would be 86410
  assert.equal(readSec(C, day), 86400, 'capped at 86400, never above');
  heartbeat.removeConnection(C);
});

// ---------------- Usage Report ----------------
test('report: completed past month is_final with billable_screens_final', () => {
  // Feb 2025 (28 days): 5 devices online 4h (ASD 0.5) every day -> Σ = 5*0.5*28 = 70.
  // BillableScreens = round(70/28) = round(2.5) = 3.
  for (let d = 1; d <= 28; d++) {
    const day = `2025-02-${String(d).padStart(2, '0')}`;
    for (let k = 0; k < 5; k++) seedRow.run(`feb-${k}`, day, 14400);
  }
  const rep = billing.buildUsageReport('2025-02', Date.UTC(2025, 5, 15));   // "now" = June -> Feb is final
  assert.equal(rep.is_final, true);
  assert.equal(rep.days_in_month, 28);
  assert.equal(rep.provisioned_screens, 5);
  assert.equal(rep.billable_screens, 3);
  assert.equal(rep.billable_screens_final, 3, 'final figure present for a complete month');
  assert.equal(rep.tier, '1-499');
  assert.equal(rep.rate_usd, 1.50);
  assert.equal(rep.cost_usd, 4.50);                         // 3 * 1.50
  assert.equal(rep.daily.length, 28);
  assert.equal(rep.daily[0].active_screen_days, 2.5);       // 5 * 0.5
});

test('report: MTD excludes today from the average (partial today does not drag it)', () => {
  const now = Date.UTC(2025, 5, 15, 10, 0, 0);   // 2025-06-15
  // Completed days 01..14: one device full 8h (ASD 1.0) each -> avg over 14 completed = 1.0.
  for (let d = 1; d <= 14; d++) seedRow.run('jun-steady', `2025-06-${String(d).padStart(2, '0')}`, 28800);
  // TODAY (15th): a huge spike of 100 devices that WOULD inflate the average if counted.
  for (let k = 0; k < 100; k++) seedRow.run(`jun-spike-${k}`, '2025-06-15', 28800);

  const rep = billing.buildUsageReport('2025-06', now);
  assert.equal(rep.is_final, false);
  assert.equal('billable_screens_final' in rep, false, 'no final figure mid-month');
  assert.equal(rep.days_elapsed, 15);
  assert.equal(rep.billable_screens, 1, 'average over COMPLETED days only (today excluded)');
  const today = rep.daily.find((x) => x.day === '2025-06-15');
  assert.ok(today && today.active_screen_days >= 100, 'today still SHOWN in daily');
  assert.equal(rep.provisioned_screens, 101, 'distinct devices seen this month incl today');
});

test('report: invalid month is rejected', () => {
  assert.throws(() => billing.buildUsageReport('2025-13'), /invalid month/);
  assert.throws(() => billing.buildUsageReport('nope'), /invalid month/);
});

// ---------------- retention (LAST — prunes old months) ----------------
test('device_usage_daily prunes via chunked-prune beyond retention', async () => {
  const old = '2020-01-01';
  const recent = billing.utcDay(Date.now());
  seedRow.run('ret-old', old, 100);
  seedRow.run('ret-new', recent, 100);
  await heartbeat.pruneUsageDaily();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM device_usage_daily WHERE day = ?').get(old).c, 0, 'old row pruned');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM device_usage_daily WHERE device_id = 'ret-new'").get().c, 1, 'recent row kept');
});
