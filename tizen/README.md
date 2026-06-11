# ScreenTinker — Tizen TV Player (`.wgt`)

A Samsung **Tizen TV / signage** web port of the ScreenTinker player. It speaks the
**exact same `/device` socket.io protocol** as the Android player, so a Tizen
display pairs and plays from the same dashboard with no server changes.

## What it does
- Enter a server URL → connects to `{server}/device` (socket.io v4).
- Registers, shows a **6-digit pairing code**; you claim it in the dashboard
  (Devices → Pair a display). On `device:paired` it switches to playback.
- Reconnects automatically with a stored `device_id` + `device_token`.
- Renders **fullscreen single-zone** playlists, looping:
  - **image** → shown for `duration_sec` (min 3s)
  - **video** (`/api/content/{id}/file` or `remote_url`) → plays to end, then next; single item loops
  - **YouTube** (`mime video/youtube`) → muted autoplay `<iframe>` embed
  - **widget** → `<iframe>` of `{server}/api/widgets/{id}/render`
- Sends `device:heartbeat` every 15s (with best-effort Tizen telemetry).
- Keeps the screen awake (`tizen.power` / Samsung `appcommon` screensaver-off).

## Files
```
config.xml          Tizen TV web-app manifest (privileges, profile, icon)
index.html          setup / pairing / stage screens
css/style.css
js/app.js           device protocol client (register, pair, heartbeat, state)
js/player.js        fullscreen playlist renderer
js/socket.io.min.js socket.io-client v4.7.5 (bundled)
icon.png
build-wgt.sh        package (signed if Tizen CLI present, else unsigned)
```

## Build
```bash
./build-wgt.sh            # -> ScreenTinker.wgt
```
Without the Tizen CLI this is an **unsigned** `.wgt`.

> **Why the released `.wgt` is unsigned:** Samsung **distributor** certificates
> are locked to the **DUID** of the signer's own TVs, so a `.wgt` we signed would
> not install on your TV anyway. Releases therefore ship it unsigned (for
> inspection only). To actually run it, use **path A** (no signing) or sign it
> yourself with your own certificate (**path B**).

## Deploy — two paths

### A) URL Launcher / TV browser (easiest, no signing)
No package, no Tizen Studio. Point the TV's **URL Launcher** (or just its web
browser) at your server's built-in web player: `https://<your-instance>/player`.
The TV runs it as a web app on boot, pairs with a 6-digit code, and plays - best
for Samsung B2B signage (SSSP). (You can instead self-host this `tizen/` folder
and point the URL Launcher at `…/index.html` for the Tizen-specific build.)

### B) Signed `.wgt` (installed app)
A signing profile is already set up on the build box (Tizen Studio CLI 6.1):
- **Profile `ScreenTinker`** = a self-signed **author** cert
  (`~/tizen-studio-data/keystore/author/st_author.p12`) + the default Tizen
  **distributor** cert. `./build-wgt.sh` auto-detects the CLI and signs with it,
  producing a `.wgt` with `author-signature.xml` + `signature1.xml`.
- This installs on **developer-mode** Samsung TVs and the **Tizen emulator** —
  the right path for a **self-hosted fleet you control** (enable Developer Mode
  on each TV once: Apps → enter `12345` → set the host IP).

Install onto a dev-mode TV:
```bash
sdb connect <tv-ip>
tizen install -n ScreenTinker.wgt -t <tv-device>
```

**Production / retail (no developer mode):** re-sign with a Samsung **Partner**
or **Public** distributor certificate from the Tizen **Certificate Manager**
(free Samsung account; distributor cert tied to each TV's **DUID**), then
`./build-wgt.sh <thatProfile>`. The self-signed author cert is not committed (it
lives in `~/tizen-studio-data`, password `screentinker`).

## Validated (2026-06-09)
- **Protocol**: headless test against the live server passed end-to-end —
  `register(pairing_code) → device:registered → pair → reconnect(device_id+token)
  → device:playlist-update(2 items) → GET /api/content/{id}/file = 200`.
- **Runtime**: loads + renders in Chromium with no JS errors (setup screen verified).
- Not yet on real Tizen hardware — needs signing + a TV (or URL Launcher).

## Not yet ported (Android player has these; fullscreen single-zone covers most signage)
Multi-zone layouts, video walls (`wall:sync`), screenshots, remote touch/control,
and self-OTA (Tizen apps update via Samsung's store / URL Launcher refresh, not the
Android `PackageInstaller` flow).
