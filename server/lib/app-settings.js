'use strict';
// #146 — minimal global key/value settings for admin-toggleable RUNTIME flags. No
// generic settings table existed (ai_settings is per-workspace, white_labels is
// branding), so this adds one (app_settings). Values are CACHED in memory and refreshed
// on write, so a hot path — e.g. /api/status, polled under load — reads a cached boolean,
// never a per-poll DB read.

const { db } = require('../db/database');

const cache = new Map();   // key -> string value
let loaded = false;

function loadAll() {
  cache.clear();
  try { for (const r of db.prepare('SELECT key, value FROM app_settings').all()) cache.set(r.key, r.value); } catch (_) { /* table may not exist yet */ }
  loaded = true;
}

function get(key, dflt) {
  if (!loaded) loadAll();
  return cache.has(key) ? cache.get(key) : dflt;
}

// Persist + refresh the cache so the change takes effect immediately (no restart).
function set(key, value) {
  const v = String(value);
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, v);
  cache.set(key, v);
  loaded = true;
}

// Boolean read with an env-default fallback: the PERSISTED value overrides once set,
// else the caller's env default applies.
function getBool(key, envDefault) {
  const v = get(key, undefined);
  if (v === undefined) return !!envDefault;
  return v === 'true' || v === '1';
}
function setBool(key, value) { set(key, value ? 'true' : 'false'); }

module.exports = { get, set, getBool, setBool, __reload: loadAll };
