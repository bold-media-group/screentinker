// Single source of truth for the running version string. Reads the root VERSION
// file once at load (the version only changes across a deploy, which restarts the
// process). Fallback '0.0.0' so a stale literal can never masquerade as a real
// release - replaces the old hardcoded '1.2.0' / '1.5.1' fallbacks.
const fs = require('fs');
const path = require('path');

let version = '0.0.0';
try {
  version = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim() || '0.0.0';
} catch { /* keep the 0.0.0 fallback */ }

module.exports = version;
