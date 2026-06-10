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

## Deploy — two paths

### A) URL Launcher (easiest, no signing) — Samsung signage (SSSP)
No package needed. Host this folder on any web server (e.g. the ScreenTinker
server itself) and point the display's **URL Launcher** at `…/index.html`.
The TV runs it as a web app on boot. Best for Samsung B2B signage displays.

### B) Signed `.wgt` (retail TVs / installed app)
Retail Tizen TVs require a Samsung-signed package:
1. Install **Tizen Studio** + the TV extension.
2. **Certificate Manager** → create a Samsung author + distributor certificate
   (needs a free Samsung account; distributor cert must include the TV's **DUID**).
3. Create a signing **profile**, then:
   ```bash
   ./build-wgt.sh <profileName>     # uses `tizen package -t wgt -s <profileName>`
   ```
4. Put the TV in **Developer Mode** (Apps → 12345 → enter host IP), then install:
   ```bash
   sdb connect <tv-ip>
   tizen install -n ScreenTinker.wgt -t <tv-device>
   ```

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
