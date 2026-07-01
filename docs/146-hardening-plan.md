# #146 — Final event-loop hardening pass (beta7, ALPHA-ONLY)

**Goal / acceptance bar:** a server that *cannot* be frozen or driven into a restart
loop by any single misbehaving device, a bloated table, or a SNAT'd request flood.
**Core invariant:** no synchronous operation may block the event loop for more than
~50ms, ever, regardless of table size or request rate. The system self-recovers to
healthy *without a process restart*.

Branch `fix/146-hardening` off the beta6 tip (keeps the crash-isolation from beta6;
beta7 = beta6 + this). **Do not bump/tag/release/deploy** — Dan bumps + pulls to alpha.

---

## (b) Confirmed failure model (verified against current code)

Two interlocked mechanisms, not one:

1. **TRIGGER** — a device flapping on a multi-second cadence (connect → ~5 content
   acks → disconnect → reconnect every ~3–5s). Each cycle is expensive (register +
   `buildPlaylistPayload` + acks) *and* writes one `device_status_log` row/cycle,
   bloating the table over the retention window. The existing burst throttle
   (`reconnectBaseMax=5` / `reconnectWindowMs=10s`, deviceSocket.js:425) does **not**
   catch it: ~2–3 connects/10s passes clean. → **Item B**.
2. **AMPLIFIER** — `pruneStatusLog()` (db/database.js:763) is a **whole-table
   `ROW_NUMBER() OVER (PARTITION BY device_id …)` sort**. On the bloated table
   (1,116,544 rows in the incident) it blocks the loop **40–48s synchronously**
   (confirmed by `mean=NaNms p99=0ms` lag samples beside `[status-log] pruned` lines).
   It runs on the heartbeat interval **and at startup** → a bloated table freezes boot
   → healthcheck fails → restart. → **Item A**.
3. **INTERLOCK** — the reconnect throttle is in-memory and resets every restart, then
   re-enters a 30s warmup where throttling is relaxed. The prune-induced restart loop
   wipes the throttle's history every cycle, so the flapper is never caught. **Ending
   the restart loop (Item A) is what lets the flap limiter (Item B) gain traction.**

---

## (a) Blast-radius audit — every synchronous, potentially-unbounded op

Legend: **EXPOSED** = can block >50ms under load/growth; **MITIGATED** = already bounded.

### Maintenance sweeps
| Path | Shape | Worst-case block | Reachable in outage? | Class | Fix |
|---|---|---|---|---|---|
| `pruneStatusLog` (db/database.js:763) | whole-table `ROW_NUMBER` sort | **40–48s @ 1.1M rows** (O(N log N)) | YES (interval + startup) | **EXPOSED — the amplifier** | A |
| `pruneLag` (loop-lag.js:92) | indexed range `DELETE … sampled_at < ?` | O(deleted); one statement can delete all-old if stalled | YES (interval + startup) | **EXPOSED** | E |
| event_loop_lag INSERT (loop-lag.js:71) | sync INSERT per sample | small, but per-tick on the loop; worsens under DB contention | YES | **EXPOSED (freq)** | E |
| `pruneTelemetry(id)` (database.js:773) | per-device `NOT IN (SELECT … LIMIT 6000)`, idx_telemetry_device | one device's excess in one DELETE; **runs per-heartbeat** (deviceSocket.js:626) | partial | **EXPOSED (freq)** | A (helper + throttle) |
| play_logs 90d prune (heartbeat.js:64) | indexed range DELETE | O(>90d rows) one statement | YES (interval) | **EXPOSED** | A |
| `pruneProvisioningDevices` (heartbeat.js:94) | DELETE devices + FK cascade | provision-flood → big cascade delete | YES (interval) | **EXPOSED** | A |
| `pruneScreenshots(id)` (database.js:785) | per-device keep-newest-1 | ~rows-per-device | partial | MITIGATED | — |
| team/workspace invite prunes (heartbeat.js:73,78) | expiry DELETE, small tables | negligible | YES | MITIGATED (route for uniformity) | A(opt) |

### Hot paths
| Path | Worst-case | Class | Fix |
|---|---|---|---|
| `device:register` (deviceSocket.js:282) — token validate, blocked SELECT, evict, DB writes, `buildPlaylistPayload` | full cost per flap; burst throttle misses 3–5s flappers | **EXPOSED** | B |
| content-ack (deviceSocket.js:647) | limiter sheds the loop cost, **but `state` Map has no eviction** (unbounded device keys) | **EXPOSED (unbounded map)** | E |
| `/api/update/check` (server.js:585) | `resolveApkPath` `existsSync`×2 **unconditional** (even on rate-backoff no-offer); `console.log` per check | **EXPOSED** | C |
| `/download/apk` (server.js:734) | `resolveApkPath` per req; **IP-keyed** log throttle (SNAT-collapsed → hid the flood); no concurrency/rate/band cap on 8.8MB `sendFile` | **EXPOSED** | C |

### Unbounded in-memory structures (invariant: every Map bounded)
`content-ack state`, `lastPlayLogAt`, `lastReclaimRejectLogAt`, writer `lastWritten`
have **no eviction** — grow with distinct device_ids (a SNAT flood minting provisioning
ids inflates them). `otaDownloadLoggedAt` is **IP-keyed** (wrong under SNAT). Bounded
already: reconnect-throttle (#146 sweep), ota-breaker (#144 sweep), `pendingOfflines`,
`evictedSockets`. → **Item E adds a shared bounded-map sweep; Item C replaces the IP map.**

### Logging
Band lines, per-request OTA lines, repetitive "Device reconnected" — synchronous
`console.log` at storm rate blocks the loop. → **Item E** coalescing buffer.

---

## Identity fallback chain (applies to Items B & D — HARD CONSTRAINT)

SNAT: the whole fleet egresses as one IP (10.10.10.1). **Never key on IP.** Resolve
identity as: `device_id` → `fingerprint` (map via `device_fingerprints`→device_id when
it resolves, else the raw fingerprint string) → `device_token` → a **single bounded
GLOBAL anon bucket**. `fingerprint` is present in the `device:register` payload
(deviceSocket.js:289). An unidentifiable client is still bucketed (global anon) so an
anonymous flood is capped, never unthrottled. Mirrors `lib/ota-breaker`'s
device_id-or-version fallback. Extracted as `lib/device-identity.js`.

---

## (c) Sequenced implementation plan — isolated commits

- **A. Non-blocking maintenance.** New `lib/chunked-prune.js` (`chunkedPrune`: bounded
  `LIMIT` batch DELETE + `setImmediate` yield between batches, optional band-gate,
  re-entrancy guard). Rewrite `pruneStatusLog` → per-device indexed prune (keep newest
  `statusLogMaxRowsPerDevice` per device via idx_device_status_log_device_ts; delete
  older + past retention), chunked, async, band-gated on the interval / un-gated at
  startup. Route play_logs, provisioning-cascade, telemetry, event_loop_lag prune
  through the helper. `STATUS_LOG_PRUNE_BATCH=2000`. Callers fire-and-forget, no
  stacking. **Tests:** correctness, ≥300k non-blocking in batches, band-gate, re-entrancy.
- **B. Flap-rate limiter.** New `lib/flap-limiter.js` — per-identity long-window connect
  frequency (`CONNECT_RATE_WINDOW_MS=300000`, `CONNECT_RATE_MAX=20`), keyed via the
  fallback chain, bounded (sweep + global anon bucket). Checked at the register gate
  before heavy work; over-limit → backoff notice + disconnect. Optional auto-quarantine
  via Item D block after N refusals. **Tests:** 4s-flapper refused, normal never,
  two device_ids independent, fingerprint-bucketed, anon-bucketed, never IP.
- **C. OTA under SNAT.** Early-return before any FS on no-offer verdict; cache APK
  resolution (path/size/mtime at boot + interval refresh); `/download/apk` global
  concurrency + global rate + band shed (503 Retry-After); replace IP log-throttle with
  a bounded aggregate per-window counter. **Tests:** rate-backoff ⇒ 0 fs calls; download
  sheds 429/503 past global cap + under critical; nothing keys on IP.
- **D. Operator block.** Move blocked check behind the identity fallback chain (catch a
  device_id-less reconnect of a blocked device via fingerprint→device_id); dashboard
  block/unblock toggle (DB write + UI + next-register effect, no restart); in-code outage
  procedure. **Tests:** blocked rejected cheaply at handshake; device_id-less+mapped-
  fingerprint still rejected; unblock next-register.
- **E. Log/write self-protection.** `lib/log-coalescer.js` (dedup+count, interval flush,
  bounded); buffer+batch event_loop_lag inserts; route its prune through `chunkedPrune`;
  add a shared bounded-map sweep for the un-evicted per-device Maps. **Tests:** N identical
  lines ⇒ 1 summarized, buffer bounded.
- **STORM HARNESS:** flapper + pre-bloated status_log + OTA flood from one SNAT IP +
  a sweep, all at once; assert loop-lag never enters a multi-second freeze and the
  server stays responsive (no NaN-sample block).

## Before/after worst-case blocking (targets)
| Hot path | Before | After (target) |
|---|---|---|
| pruneStatusLog @1.1M | 40–48s | <50ms/batch, many batches |
| play_logs / provisioning / lag prune | O(all-old) one stmt | <50ms/batch |
| /api/update/check (no-offer) | existsSync×2 + log | 0 FS, coalesced log |
| /download/apk flood | unbounded sendFile + hidden | global-capped, 503 shed, visible |
| event_loop_lag telemetry | sync INSERT/sample | batched flush |
| device:register (flapper) | full build every ~4s | refused at gate, cheap |
