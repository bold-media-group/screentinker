'use strict';
// #146 hardening (Item C) — cache the OTA APK resolution so no /api/update/check or
// /download/apk does a per-request synchronous filesystem call. The path/size/mtime are
// resolved once at boot and refreshed on an interval (like the frontend-hash refresh),
// so a poll/download flood can't turn into an existsSync/statSync flood on the loop.

const fs = require('fs');
const path = require('path');
const config = require('../config');

// A copy under DATA_DIR wins (container operators mount /data/ScreenTinker.apk),
// else the legacy in-repo root path — same order as the old resolveApkPath().
function candidates() {
  return [path.join(config.dataDir, 'ScreenTinker.apk'), path.join(__dirname, '..', '..', 'ScreenTinker.apk')];
}

let cache = { path: null, exists: false, size: 0, mtime: 0 };

function refresh() {
  for (const p of candidates()) {
    try { const st = fs.statSync(p); cache = { path: p, exists: true, size: st.size, mtime: st.mtimeMs }; return cache; } catch (_) { /* next */ }
  }
  cache = { path: null, exists: false, size: 0, mtime: 0 };
  return cache;
}

function get() { return cache; }

let timer = null;
function start() {
  refresh();                                   // resolve once at boot
  if (!timer) {
    timer = setInterval(refresh, config.otaApkRefreshMs);
    if (timer.unref) timer.unref();
  }
  return cache;
}

module.exports = { start, refresh, get };
