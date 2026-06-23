# #109 — Android PiP overlay not painting over YouTube

## Symptom

`POST /api/pip` returns `sent: 1`, the overlay's title text appears in
`uiautomator dump` (so the view IS attached, laid out, and on-screen in the
accessibility tree), but **nothing paints on the panel**. The repro is while
**YouTube** content is playing (`R.id.youtubeWebView`).

The PiP title and its media are siblings in one box, so "title in the dump but
nothing on screen" means the **whole box is attached-but-not-painting**, not a
media-only failure.

## The three candidate causes

| # | Cause | What the magenta-box instrumentation shows |
|---|-------|--------------------------------------------|
| 1 | **Surface occlusion** — the YouTube WebView's hardware video plane composites *above* the in-tree overlay | magenta box visible over a static image but **not** over YouTube |
| 2 | **Orientation transform** — `rootView`'s rotation/translation pushes the box off-screen | box `getGlobalVisibleRect()` empty / outside the 1920×1080 panel |
| 3 | **Measure / visibility** — `pipLayout` not laid out, 0-size, or `GONE` on attach | box not shown / 0-size / `pipLayout` `childCount==0` |

## Phase 1 — Instrumentation (shipped, default OFF)

A `pipDebug` flag (`PipOverlay.pipDebug`, default `false`) is toggled over the
**existing** `device:command` transport — no new transport invented:

```
device:command { "type": "pip_debug", "payload": { "enabled": true } }
```

When on, `PipOverlay.show()`:

- paints the box **solid magenta** (`#CCFF00FF`) with an 8px magenta border and
  renders the media on top, so the **box paints even if the media never loads**;
- posts a one-shot Runnable that logs, over `device:log` tag **`pip`**:
  - `box` width/height, `getGlobalVisibleRect()`, `isShown`
  - `pipLayout` width/height/visibility/childCount + its index in its parent
  - `rootView` rotation / translationX / translationY / scaleX / `isHardwareAccelerated`
  - `youtubeWebView` visibility + `getGlobalVisibleRect()`
- `loadImageInto` also logs on **success** (bitmap w/h), not just failure.

`pipDebug` is left present and default-false.

## Phase 2 — Reproduce

Enable remote debug logging from the dashboard (so `device:log` is forwarded),
then enable the PiP debug flag, then fire a PiP under each content type and read
the `pip`-tagged lines.

**(a) PiP over a static image**

1. Assign a single still image to the device; let it display.
2. `device:command {type:"pip_debug",payload:{enabled:true}}`.
3. `POST /api/pip {device_id, type:"image", uri:"https://…/x.png", position:"top-right", duration:30}`.
4. Capture the `pip dbg …` lines + a screenshot.

**(b) PiP over YouTube** (the failing repro)

1. Assign a YouTube item; let it play in `R.id.youtubeWebView`.
2. (debug already enabled.)
3. Same `POST /api/pip` as above.
4. Capture the `pip dbg …` lines + a screenshot.

Decision table (compare a-vs-b):

- magenta box visible over the image but **NOT** over YouTube → **(1) surface occlusion**
- box `globalRect` empty / off the 1920×1080 panel → **(2) orientation**
- box not shown / 0-size / not laid out → **(3) measure/visibility**

> Note: on-device capture must be done on the real signage hardware (Fire TV /
> Android TV). The WebView hardware-video-overlay behaviour that drives cause (1)
> is device- and WebView-version-specific and does **not** reproduce on a stock
> emulator, so it cannot be captured from a CI/dev box with no device attached.

## Which cause — and the fix

By elimination the symptom points at **(1) surface occlusion**:

- It is **YouTube-specific** (a WebView playing HTML5 video). An orientation (2)
  or measure (3) fault would fail over images too, but the overlay is only
  reported broken over YouTube.
- The repro is **landscape** (the default orientation → `rotation = 0`, no
  translation), so the box cannot be transformed off-screen → not (2).
- The title shows with **real on-screen bounds** in `uiautomator dump`, so the
  box is laid out at non-zero size and `pipLayout` is `VISIBLE` → not (3).

That leaves the video surface compositing above the in-tree overlay.

### Fix (cause 1) — file/line

`pipLayout` previously lived as the **last child of `rootLayout`**, i.e. in the
**same compositing band** as `R.id.youtubeWebView`; the WebView's playing video
surface drew over it. The fix moves the PiP layer to a **top-level view above the
WebView** (the task's option 1a):

- **`MainActivity.onCreate`** (`android/app/src/main/java/com/remotedisplay/player/MainActivity.kt`)
  reparents `R.id.pipLayout` out of `rootLayout` up to the window content
  (`android.R.id.content`), as a sibling drawn **after** `rootLayout` → it
  composites above the WebView.
- **`MainActivity.mirrorTransformToPip()`** copies `rootView`'s current size +
  rotation/translation/scale onto `pipLayout` after every transform change
  (`applyOrientation` / `applyWallTransform`), so corner positions still track the
  rotated content — mirroring how the web/Tizen players apply the same transform
  to `#pip` as to `#stage`.
- **`PipOverlay.show()`** (`…/player/PipOverlay.kt`) raises the layer and forces a
  layout/redraw on attach (`bringToFront()` + `requestLayout()` + `invalidate()`),
  which also covers the cause-(3) measure/visibility path.
- The remote-view screenshot source moved from `rootView` to `captureRoot`
  (the window content) so the reparented PiP is still captured.

### Server dispatch logging

`POST /api/pip` and the clear handler (`server/routes/pip.js`) now log one
concise `[pip] …` line each (target kind + id + sent/offline counts) so
`journalctl` shows PiP activity.

## Emulator validation (landscape + portrait)

The fix was exercised end-to-end on an Android emulator (pixel10, API 34) paired
to an isolated local server, with a YouTube item playing in
`R.id.youtubeWebView`:

- **No crash** — provisioning → `MainActivity` → playback ran clean; the reparent
  + `mirrorTransformToPip()` executed (`Applied orientation: landscape … / portrait
  (rotation=90.0, swap=true)`).
- **PiP composites above the playing YouTube video** — a `POST /api/pip` box
  (magenta via `background_color`) rendered on top of the live video frame
  (center and top-right placements both correct, 4% inset honoured).
- **Clear** removed the overlay cleanly; the video kept playing.
- **Portrait** — the overlay rotated *with* the rotated stage and stayed inside
  the frame (not off-screen), confirming the transform mirror.
- Server `[pip] show … 1 sent` / `[pip] clear (all) …` dispatch lines appeared.

Caveat (unchanged): the emulator's WebView composites video **inline**, so it
confirms the reparent renders correctly and doesn't regress, but it does **not**
reproduce the Fire TV / Android TV hardware-overlay punch-through that is the
strongest form of cause (1). That still needs the real signage device — use the
`pipDebug` magenta box there to confirm.

### Follow-up bug found in emulator testing: image PiPs never painted the image

Verifying an **image** PiP (a QR PNG) surfaced a separate, pre-existing defect
(present on `main`, unrelated to the occlusion reparent): the image area was
always blank — only the box background + title showed. Root cause in
`PipOverlay.show()`: `teardown()` clears `current` to null, then `loadImageInto`
captured `token = current` (null) as its drop-if-replaced guard, but `current`
was only set to the new `pip_id` *after* the media was built. The decode finishes
on a background thread and posts back **after** `show()` returns — so the guard
`token != current` (null ≠ pip_id) was always true and **every decoded bitmap was
dropped**. (Web PiPs and the box/title were unaffected, which masked it.)

Fix: set `current = pip_id` **before** building the media (so `loadImageInto`'s
token matches). Confirmed on the emulator — the QR now renders in the PiP box
over both a static image and live YouTube.

### Content types verified on the emulator (over live YouTube)

- **image** PiP (a QR PNG) — renders after the token-ordering fix above.
- **web** PiP (an HTML page) — loads in the PiP WebView and **executes JS** (a
  page that stamps `JS OK · <time>` into the DOM rendered correctly over the
  playing video); composites above the main YouTube WebView. No code change
  needed — web PiPs never went through the broken image path.
- title + `background_color` box — paints above the video (the original cause-1
  fix).
- **`close_button: true`** — the server already forwarded this flag
  (`routes/pip.js`) and it's in `openapi.yaml`, but no player rendered it (Tizen
  deferred "close-button focus" as non-MVP; the web player has none). Implemented
  on Android: a tappable ✕ floats at the box's top-right (a sibling of the box, so
  it isn't clipped by the outline or dimmed by `opacity`) and clears THIS overlay
  (id-matched) on tap. Only the ✕ is clickable; the rest of the full-screen
  `pipLayout` stays touch-transparent so taps fall through to the content. Verified
  on the emulator — tapping it removed the overlay and the video kept playing.
  Parity note: the web/Tizen players still don't implement `close_button`; D-pad
  focus of the ✕ on non-touch TV hardware is intentionally not wired (MVP =
  touch/pointer only, matching the Tizen focus deferral).

## If the magenta box is STILL hidden over YouTube on the test device

Then it is the stronger form of cause (1): the WebView places its video on a
**hardware overlay / `SurfaceView` plane** that no in-window view can beat.
Escalate (task options 1b/1c), keeping the first that works on the device:

- host the PiP box in a `SurfaceView` with `setZOrderMediaOverlay(true)` /
  `setZOrderOnTop(true)`, or a small `WindowManager` panel sub-window; or
- when YouTube is active, render the PiP via the in-tree image path so no
  competing WebView video surface is involved.

The `pipDebug` instrumentation stays in place to make that determination.
