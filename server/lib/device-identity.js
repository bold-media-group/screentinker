'use strict';
// #146 hardening — SNAT-safe identity resolution for any per-device keying (flap
// limiter, operator block, throttles). The whole fleet egresses as ONE IP
// (10.10.10.1, Sophos SNAT), so keying on IP collapses the fleet into one bucket —
// FORBIDDEN. Resolve identity from the device:register payload via the fallback chain:
//
//   device_id
//     -> fingerprint (map via device_fingerprints -> device_id when it resolves,
//        else the raw fingerprint string)
//       -> device_token
//         -> a single BOUNDED GLOBAL anon bucket (final backstop)
//
// An unidentifiable client is STILL bucketed (collectively, via the anon bucket) so an
// anonymous flood is capped, never unthrottled. Mirrors lib/ota-breaker's
// device_id-or-version fallback. `fingerprint` is present in the register payload;
// device_fingerprints maps fingerprint -> device_id. NEVER keys on IP.

const { db } = require('../db/database');

const ANON_KEY = 'anon:global';

// Returns { key, kind, deviceId } — `key` is stable for keying; `deviceId` is the
// resolved device id when the chain produced one (device_id directly or via
// fingerprint), else null.
function resolveIdentity(payload = {}) {
  const { device_id, fingerprint, device_token } = payload;

  if (device_id) return { key: 'd:' + device_id, kind: 'device_id', deviceId: device_id };

  if (fingerprint) {
    let mapped = null;
    try {
      const row = db.prepare('SELECT device_id FROM device_fingerprints WHERE fingerprint = ?').get(fingerprint);
      mapped = row && row.device_id ? row.device_id : null;
    } catch (_) { /* table may not exist on a partially-migrated DB */ }
    if (mapped) return { key: 'd:' + mapped, kind: 'fingerprint->device_id', deviceId: mapped };
    return { key: 'f:' + fingerprint, kind: 'fingerprint', deviceId: null };
  }

  if (device_token) return { key: 't:' + device_token, kind: 'device_token', deviceId: null };

  return { key: ANON_KEY, kind: 'anon', deviceId: null };
}

module.exports = { resolveIdentity, ANON_KEY };
