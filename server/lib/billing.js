'use strict';

// #146 BILLING — usage metering per the ByteTinker–Bold Media distribution agreement.
// This module is the CONTRACTUAL SYSTEM-OF-RECORD math. It reads ONLY the durable daily
// rollup (device_usage_daily) — never raw logs — so the Usage Report is cheap.
//
// Contract definitions (see docs/billing.md):
//   ASD (Active Screen-Day, per device per day) = min(1.0, online_seconds / (hours*3600))
//   BillableScreens (per month) = round( Σ ASD over all devices & days / days_in_month )
//     → the average number of screens active during a standard 8-hour day, round HALF UP.
//   Tier is FLAT (not marginal): the single rate for the month's total BillableScreens.
//   Cost = BillableScreens × tier rate.

const config = require('../config');
const { db } = require('../db/database');

// --- date helpers (UTC — deterministic, server-timezone-independent; the accumulator
// writes UTC day keys, and the report groups by the same keys, so they always align) ---
function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }   // YYYY-MM-DD
function utcMonth(ms) { return new Date(ms).toISOString().slice(0, 7); }  // YYYY-MM
function daysInMonth(month) { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// --- pure contract math (exported for unit tests) ---

// ASD for one device on one day.
function activeScreenDay(onlineSeconds) {
  const denom = config.billing.hoursPerDay * 3600;   // 28800 default
  return Math.min(1.0, onlineSeconds / denom);
}

// Round half up. (Math.round already rounds .5 up for positive values; explicit for
// intent — "nearest whole screen, round half up" per the agreement.)
function roundHalfUp(x) { return Math.floor(x + 0.5); }

// BillableScreens = round( Σ ASD / days ). `days` is the CALENDAR-day denominator (see
// buildUsageReport for month-to-date vs final).
function billableScreens(sumAsd, days) {
  if (days <= 0) return 0;
  return roundHalfUp(sumAsd / days);
}

// The flat tier for a given screen count: the rate whose minScreens is the greatest ≤
// screens. Returns null below the lowest threshold (e.g. 0 screens → not billed).
function tierFor(screens) {
  const table = [...config.billing.rateTable].sort((a, b) => a.minScreens - b.minScreens);
  let chosen = null;
  for (const t of table) if (screens >= t.minScreens) chosen = t;
  return chosen;
}

// Human tier label from the rate table thresholds, e.g. "1-499", "500-999", "1000+".
function tierLabel(screens) {
  const table = [...config.billing.rateTable].sort((a, b) => a.minScreens - b.minScreens);
  const idx = table.reduce((acc, t, i) => (screens >= t.minScreens ? i : acc), -1);
  if (idx < 0) return null;
  const next = table[idx + 1];
  return next ? `${table[idx].minScreens}-${next.minScreens - 1}` : `${table[idx].minScreens}+`;
}

function round2(x) { return Math.round(x * 100) / 100; }

// --- Usage Report (the API payload) ---
// Reads device_usage_daily only. `nowMs` is injectable for deterministic tests; the route
// passes Date.now().
//
// MONTH-TO-DATE RULE: for the CURRENT month the billable-screens average is computed over
// COMPLETED calendar days only — today accrues live and is shown in `daily` but is EXCLUDED
// from the running average until it completes, so a partial today doesn't drag the estimate
// down. For a past (final) month every day is complete, so the same formula yields the
// contractual Σ ASD / days_in_month.
const _asdByDay = db.prepare(
  `SELECT day, SUM(MIN(1.0, online_seconds / CAST(? AS REAL))) AS asd
     FROM device_usage_daily WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`
);
const _distinctDevices = db.prepare(
  'SELECT COUNT(DISTINCT device_id) AS c FROM device_usage_daily WHERE day BETWEEN ? AND ?'
);

function buildUsageReport(monthArg, nowMs = Date.now()) {
  const month = monthArg || utcMonth(nowMs);
  if (!MONTH_RE.test(month)) throw new Error('invalid month (expected YYYY-MM)');

  const dim = daysInMonth(month);
  const firstDay = `${month}-01`;
  const lastDay = `${month}-${String(dim).padStart(2, '0')}`;
  const todayStr = utcDay(nowMs);
  const nowMonth = utcMonth(nowMs);

  // Where are we relative to this month?
  let isFinal, completedDays, daysElapsed;
  if (month < nowMonth) { isFinal = true;  completedDays = dim;                       daysElapsed = dim; }
  else if (month > nowMonth) { isFinal = false; completedDays = 0;                    daysElapsed = 0; }
  else { isFinal = false; const todayDom = new Date(nowMs).getUTCDate(); completedDays = todayDom - 1; daysElapsed = todayDom; }

  const denom = config.billing.hoursPerDay * 3600;
  const rows = _asdByDay.all(denom, firstDay, lastDay);       // [{day, asd}] per day WITH data
  const provisioned = _distinctDevices.get(firstDay, lastDay).c;

  // Sum ASD over COMPLETED calendar days only (day strictly before today). For a past
  // month todayStr is in a later month, so every row qualifies.
  let sumAsdCompleted = 0;
  const daily = [];
  for (const r of rows) {
    daily.push({ day: r.day, active_screen_days: Math.round(r.asd * 1000) / 1000 });
    if (r.day < todayStr) sumAsdCompleted += r.asd;
  }

  const billable = billableScreens(sumAsdCompleted, completedDays);
  const tier = tierFor(billable);
  const rate = tier ? tier.rate : 0;

  const out = {
    month,
    days_in_month: dim,
    days_elapsed: daysElapsed,
    provisioned_screens: provisioned,
    billable_screens: billable,
    is_final: isFinal,
    tier: tierLabel(billable),
    rate_usd: rate,
    cost_usd: round2(billable * rate),
    daily,
  };
  // Only present once the month is complete (agreement §4.1 finalized figure).
  if (isFinal) out.billable_screens_final = billable;
  return out;
}

module.exports = {
  activeScreenDay, roundHalfUp, billableScreens, tierFor, tierLabel,
  buildUsageReport, utcDay, utcMonth, daysInMonth,
};
