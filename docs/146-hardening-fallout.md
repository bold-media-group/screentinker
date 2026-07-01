# #146 hardening — Fallout summary + before/after (beta7, ALPHA-ONLY)

Branch `fix/146-hardening` (off beta6). Isolated commits A–E + storm harness. Suite
**267/267**. **Not bumped/tagged/released** — Dan bumps via bump-version.sh + pulls to
alpha. Below: what each change touches, wider blast radius, what a soak watcher should
watch, and the measured worst-case blocking cost per hot path.

## What each item touches / blast radius / soak signals

### A — non-blocking maintenance (`chunked-prune.js`, `db/database.js`, `heartbeat.js`)
- **Touches:** `pruneStatusLog` rewritten (per-device, chunked, async, band-gated,
  re-entrant); play_logs + provisioning prunes chunked; `pruneTelemetry` bounded; new
  index `idx_devices_provisioning`; heartbeat interval maintenance moved to async
  `runMaintenance()`. **`pruneStatusLog` / `pruneProvisioningDevices` are now async** —
  every caller must await (heartbeat + the two prune tests updated).
- **Blast radius:** heartbeat interval restructured; offline-marking unchanged & still
  synchronous. All table-growth sweeps now ride `chunkedDelete`.
- **Soak signals:** startup prune runs in the background (boot no longer blocks on a
  bloated table — self-heals Bold's on-disk bloat on first deploy). Interval maintenance
  is **band-gated**: under sustained non-normal lag it *defers* and resumes when band
  returns to normal — expected, not a fault. Log line format changed:
  `[status-log] pruned N (per-device, newest 500/device + 3d retention, batches of 2000)`.

### B — flap-rate limiter (`flap-limiter.js`, `device-identity.js`, register gate)
- **Touches:** new refusal at the register gate for a device connecting > `CONNECT_RATE_MAX`
  (20) per `CONNECT_RATE_WINDOW_MS` (5min), keyed via the identity chain. Emits
  `device:throttled {reason:'connect_rate'}` + disconnect. Sweep started in server.js.
- **Wider blast radius:** shares the `device:throttled` event with the #142 reconnect
  throttle (clients already handle it).
- **Auto-quarantine (P0 — behavior change):** after `CONNECT_RATE_QUARANTINE_TRIPS` (5)
  trips a hard flapper is quarantined **IN-MEMORY for `CONNECT_RATE_QUARANTINE_MS`
  (30min) and AUTO-CLEARS** — it is **NOT** a DB block. A stuck-then-recovered device
  comes back on its own with no human action. `devices.blocked` is written **only** by an
  operator (dashboard / direct SQLite). (Was: a permanent `blocked=1` auto-write — a
  self-healing auto-action must not survive as a durable DB row.)
- **Soak signals:** `[flap] quarantined <id> for 30m after N trips` (logged once at the
  START); repeat refusals are coalesced. Also visible on `/api/status` →
  `debug.flap.{buckets,quarantined}`. A legit device on a flaky network reconnecting
  >20×/5min would be refused — if false positives appear, raise `CONNECT_RATE_MAX`. The
  global anon bucket (cap 60) collectively caps truly-unidentifiable clients; real fleet
  devices always resolve to device_id/fingerprint.

### C — OTA under SNAT (`apk-cache.js`, `ota-download-guard.js`, server.js)
- **Touches:** `/api/update/check` early-returns before any fs on no-offer; APK
  metadata cached (60s refresh); `/download/apk` gains BAND-AWARE global concurrency +
  rate caps + critical-band shed (**503 Retry-After**); IP-keyed log throttle replaced by
  a per-window served/shed aggregate.
- **Band-aware downloads (P1.2 — behavior):** the concurrency/rate caps are a **load-time
  backstop, not a healthy-state limiter**. Under `band=normal` downloads serve **FREELY**
  (no cap) — a coordinated whole-fleet rollout is NOT staggered when the server is
  healthy. The caps engage only under `elevated`; `critical` sheds (503). This fixes
  rollout staggering (a shed 503 costs a client a full ~30-min re-check cycle).
- **Behavior change (watch):** downloads can return **503** only under elevated/critical —
  clients retry per Retry-After. A freshly-swapped APK is picked up within the 60s cache
  refresh (slight delay by design). Observable on `/api/status` →
  `debug.ota_download.{inFlight,servedThisWindow,shedThisWindow}`. If legit downloads get
  shed under load, raise `OTA_DOWNLOAD_MAX_CONCURRENT` / `OTA_DOWNLOAD_MAX_PER_WINDOW`.
- **Soak signals:** `[ota] downloads last 60s: X served, Y shed` — a flood is now VISIBLE.

### D — operator block (`deviceSocket`, `routes/devices.js`, frontend)
- **Touches:** blocked check resolves the effective device_id via the identity chain
  (catches a device_id-less reconnect of a blocked device); `POST /api/devices/:id/{block,
  unblock}`; a Block/Unblock button in `device-detail.js` + `api.js`.
- **Blast radius:** register gate ordering (block is still first); one new frontend
  button (needs a browser smoke on alpha — not covered by node --test).
- **Soak signals:** `[blocked] …` logs; block/unblock take effect on the device's next
  register with no restart. Combined with B, a hard flapper can be auto-blocked.

### E — log/write self-protection (`log-coalescer.js`, `loop-lag.js`, `content-ack-limiter.js`, `status-log-writer.js`)
- **Touches:** high-frequency lines coalesced (band "still loaded", OTA check, "Device
  reconnected") — one summarized line per key per 30s; band CHANGES stay immediate.
  `event_loop_lag` inserts BUFFERED + batch-flushed every 10s (bounded buffer);
  its prune rides `chunkedDelete`. content-ack Map swept; writer `lastWritten` capped.
- **Behavior change (watch):** fewer, summarized log lines (`… (x47 in 30s)`);
  `event_loop_lag` table lags real time by up to 10s (**/api/status is unaffected** — it
  reads in-memory current, so real-time band/alerting is intact).

### `/api/status.debug` THROUGHPUT counters (soak observability)
Each subsystem now exposes gauges **and** throughput (running `Total` + last-completed-
`LastWindow`, `DEBUG_STATS_WINDOW_MS` default 60s) so the server tells the flapper/flood
story on its own — no client trust:
- `flap.refusedLastWindow` — refusals/window. **Climbing while `band=normal` = the limiter
  absorbing a flapper cheaply (the healthy signature — this is what "36 buckets, 0
  quarantined" looked like but couldn't show). Climbing WITH band elevated/critical =
  investigate.**
- `flap.quarantineStartsTotal/LastWindow` — a quarantine EVENT is visible even though the
  `quarantined` gauge decays.
- `ota_breaker.rateBackoffLastWindow` — a device=none 1.8.x update-check flood shows here.
- `ota_download.servedTotal/shedTotal` — a download flood: `shedTotal` climbing = the
  global cap engaging (only under elevated/critical).
- `maintenance.sweepsTotal` — confirms the prune is FIRING on its interval, not stalled
  (with `deleted`/`ms` for cost). All aggregate-only, cheap in-memory reads.

## Before / after — worst-case synchronous blocking (measured)
| Hot path | Before | After (measured) |
|---|---|---|
| `pruneStatusLog` @ 300k–1.1M rows | whole-table `ROW_NUMBER` sort, **40–48s** (incident) | chunked; **max event-loop gap <300ms** across the storm harness (300k rows) / <250ms in the prune test |
| play_logs / provisioning / lag prune | O(all-old) in one DELETE | chunked, ≤ one 2000-row batch per statement (<50ms) |
| `pruneTelemetry` (per heartbeat) | `NOT IN (SELECT … 6000)` per call | bounded single `OFFSET 6000 LIMIT 2000` statement |
| `/api/update/check` (no-offer) | `existsSync`×2 every poll | **0 fs calls** (early-return + cache) |
| `/download/apk` under flood | unbounded concurrent 8.8MB `sendFile`; flood hidden | global concurrency+rate capped; **503 shed**; flood visible |
| `event_loop_lag` telemetry | synchronous INSERT per sample | buffered, **batch-inserted every 10s** |
| `device:register` (4s flapper) | full register + `buildPlaylistPayload` every ~4s | refused at the gate (identity resolve + one indexed SELECT), cheap |

## Kill switches (env — disable a subsystem with a flip + restart, no redeploy)
Every new subsystem is disable-able so a misfire on alpha is neutralized without a code
change or bisect. All read at process start.

| Subsystem | Env | Disable value | Effect when off |
|---|---|---|---|
| Flap limiter | `FLAP_LIMITER_ENABLED` | `false` | `check()` always allows — no connect-frequency limiting |
| Auto-quarantine | `CONNECT_RATE_QUARANTINE_TRIPS` | `0` | flappers still cool down, but are never quarantined |
| Download guard | `OTA_DOWNLOAD_GUARD_ENABLED` | `false` | `/download/apk` never sheds (no concurrency/rate/band caps) |
| Maintenance band-gate | `MAINTENANCE_BAND_GATE_ENABLED` | `false` | interval maintenance runs regardless of loop-lag band |
| Flap window / cap (tune, not off) | `CONNECT_RATE_MAX`, `CONNECT_RATE_WINDOW_MS` | raise `MAX` | loosen if healthy devices are refused |
| Download caps (tune) | `OTA_DOWNLOAD_MAX_CONCURRENT`, `OTA_DOWNLOAD_MAX_PER_WINDOW` | raise | loosen the elevated-band caps |
| Prune batch (tune) | `STATUS_LOG_PRUNE_BATCH` | lower | smaller batches = smaller max block |

Note the startup prune is intentionally NEVER band-gated (it must clear a boot-time
backlog); `MAINTENANCE_BAND_GATE_ENABLED` only affects the interval run.

## P2 findings (investigated; measured)
- **Playlist build under mass reconnect — MITIGATED, no change.** `buildPlaylistPayload`
  is synchronous (indexed SELECTs + one `JSON.parse` of the published snapshot). Measured
  with a 200-item snapshot: **avg 0.078ms, max 0.70ms per call**; a 230-device fleet-wide
  reconnect is ~18ms of CPU **spread across 230 separate socket.io handler invocations**
  (the loop yields between them), never one block. Per-call is the real unit and is far
  under the 50ms invariant. (`test/playlist-build-cost.test.js`.)
- **Boot health during a large startup trim — CONFIRMED.** Booting against a pre-bloated
  300k-row `device_status_log`, `/api/status` answers in **<3s** while the table is still
  large (prune trickling), and the backlog drains to the cap in the background with the
  server responsive throughout. The old whole-table sort froze boot ~40s. This is the
  point of the async/chunked, un-gated startup prune. (`test/boot-health.test.js`.)

## Interlock note
Item A ends the prune-induced restart loop; Item B's in-memory flap state now persists
long enough to bite (it used to be wiped every ~40s by the restart). The two are a pair:
ship/soak them together.
