# Android Player — Troubleshooting & Recovery

Practical runbook for the RemoteDisplay / ScreenTinker Android player
(package `com.remotedisplay.player`, shown on the device as **RemoteDisplay**).

---

## Symptom: player stuck on "Connecting to server"

The UI sits on **"Connecting to server…"** and never pairs/plays. In `logcat`
you'll see this repeating every few seconds:

```
E WebSocketService: Connection error: io.socket.engineio.client.EngineIOException: xhr poll error
```

`xhr poll error` is a **transport-level** failure — the Socket.IO client can't
even open an HTTP connection to the configured server. It is **not** an auth
rejection and **not** a code crash (those happen *after* the socket connects).

### What it almost always means
The player's stored **server URL points at a host it can no longer reach.**
Most common causes, in order:

1. **Server moved / IP changed.** The device was provisioned against a local
   dev box (`http://192.168.x.x:3000`) and that machine's IP changed or it's
   on a different network now.
2. **Local dev server is down.** `remotedisplay.service` isn't running.
3. **No internet route.** The device's Wi-Fi genuinely can't reach the
   internet (only relevant if it points at `https://screentinker.com`).

### Quick triage (no device access needed)
```bash
# Is the intended server even up?
curl -s -m 8 -o /dev/null -w "%{http_code}\n" https://screentinker.com/   # expect 200

# Local dev server running?
systemctl is-active remotedisplay.service
```
If the target server is up and on the **same LAN** as the device, the player
*should* connect once it's pointed there — so the fix is re-pointing the device.

> An APK upgrade does **not** cause this. `adb install -r` preserves app data,
> so the stored server URL survives the upgrade. Cleartext (`http://`) is
> allowed (`usesCleartextTraffic="true"` in the manifest), so upgrading does
> not block local servers either.

---

## Fix: re-point the player to a different server

The app only shows its **setup screen** when it is *not provisioned/paired*
(`MainActivity`: `if (!config.isProvisioned || !config.isPaired) -> ProvisioningActivity`).
So to change servers you must reset that state. Two ways:

### A. On the phone, no tools (most reliable)
1. **Settings → Apps → RemoteDisplay → Storage → Clear data.**
   This wipes the stale server URL and pairing. (Cached content is cleared too;
   it re-downloads after pairing — no harm.)
2. Reopen **RemoteDisplay** → the setup screen appears.
3. Enter the server URL, e.g. **`https://screentinker.com`** → tap **Connect**.
4. It shows a **6-digit pairing code**.
5. In the dashboard (e.g. screentinker.com), pair a device with that code.
   The phone flips to "Paired as: …" and starts playing.

> After **Clear data**, the **Accessibility** permission the app uses for
> remote power/navigation is also reset. Re-enable it if you need remote
> reboot/screen control: Settings → Accessibility → RemoteDisplay → On.

### B. Via adb (if you have a working connection)
```bash
D=<ip:port>
# Option 1: reset provisioning the same way "Clear data" does
adb -s $D shell pm clear com.remotedisplay.player
adb -s $D shell monkey -p com.remotedisplay.player -c android.intent.category.LAUNCHER 1

# Option 2 (inspect first): read the currently-configured server URL
#   NOTE: release builds are NOT debuggable, so `run-as` returns nothing and
#   you cannot read /data/data/.../shared_prefs without root. Prefer Clear data.
```

---

## Connecting adb over Wi-Fi (Android 11+ Wireless Debugging)

Used to drive the device for installs/log capture. Ports here are **per-session
and change** when wireless debugging is toggled or the device reboots.

1. On device: **Developer options → Wireless debugging → On.**
2. **Pair** (one-time per host): tap *"Pair device with pairing code"*. It shows
   a **pairing port** (different from the connect port) and a **6-digit code**:
   ```bash
   adb pair <ip>:<pairing-port> <6-digit-code>
   ```
3. **Connect** using the **"IP address & Port"** from the *main* Wireless
   debugging screen (the *connect* port, not the pairing port):
   ```bash
   adb connect <ip>:<connect-port>
   ```

### Finding the ports when the UI/mDNS won't tell you
mDNS discovery (`adb mdns services`) **only works on the same L2 subnet**; it
won't cross a router. If the device is a hop away, scan for the open ports:
```bash
nmap -p 30000-50000 --open -T4 <ip> | grep open
```
The **connect** and **pairing** ports are random in the high range and churn;
the pairing port only exists while the pairing dialog is open.

### Gotchas learned the hard way
- **Be on the same subnet.** A wireless-debug *connect* port that is TCP-open
  from across a router can still refuse the adb/TLS handshake. Pairing tolerates
  routing; connecting often does not. Put your machine on the **same /24** as
  the device.
- **Do NOT run `adb root` over a wireless connection.** It restarts `adbd` in
  root mode, which **drops the TLS connection and stops re-binding the connect
  port** — the phone keeps *displaying* the old port but it's refused. Recovery
  is a **phone reboot** (or `adb unroot`, which you can't reach because you're
  disconnected). Release builds aren't debuggable anyway, so root buys you
  little here — prefer **Clear data** for config resets.
- After a reboot or a wireless-debugging toggle, the connect port **changes** —
  re-read it from the device and reconnect (pairing usually persists).

---

## Reference: where things live

| Thing | Location |
|---|---|
| Package id | `com.remotedisplay.player` |
| Display name | RemoteDisplay |
| Server URL entry | `ProvisioningActivity` (`R.id.serverUrlInput`) |
| Routing to setup | `MainActivity` → `if (!isProvisioned || !isPaired)` |
| Connection client | `service/WebSocketService.kt` (Socket.IO) |
| Cleartext allowed | `AndroidManifest.xml` → `usesCleartextTraffic="true"` |
| Build a signed APK | `KEYSTORE_PASSWORD=… KEY_PASSWORD=… ./gradlew assembleRelease` |
| APK output | `android/app/build/outputs/apk/release/app-release.apk` |
