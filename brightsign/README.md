# ScreenTinker on BrightSign

The player is the ordinary web player (`server/player/index.html`) running in an `roHtmlWidget`.
It already runs unmodified on real hardware — a Series 5 (HD1026, BOS 9.1, Chromium 120) played
4,723 items over 12.4h averaging 9.4s against a 10s slot. So the port is not "can it run". It is
the four things a page cannot do for itself.

```
  autorun.brs      the host: owns the widget, identity, outputs, recovery
      | @brightsign/messageport  (bidirectional)
  st-bridge.js     the page's half of the same contract
      |
  server/player/index.html        the unmodified player
```

## Files

| file | role |
|---|---|
| `autorun.brs` | BrightScript host. Builds the widget, supervises it, persists identity, drives a second output, executes what the page cannot. |
| `st-bridge.js` | Loaded by the player on this platform. Registry identity, restart-instead-of-reload, heartbeat, sync-backend reporting. Degrades to no-ops everywhere else, so it is safe to load unconditionally. |
| `st-sync.js` | Native SyncManager adapter. Inert without the platform module, so the player falls back to its own group sync. |
| `probe.html` | The original capability probe. Still useful on a new model/OS build. |
| `offline.html` | Local fallback page — names the server, keeps probing it, and asks the host to restart the player the moment it answers. |

## The four things the host exists for

**1. It owns the widget lifecycle.** A page-initiated `location.reload()` does not reliably bring
an `roHtmlWidget` back. On 2026-07-28 a ScreenTinker deploy reloaded every connected player;
the BrightSign was the only one that never returned, and a browser on the same deploy reloaded and
was heartbeating minutes later. So the page never reloads itself here — it posts
`{type:"restart"}` and the host tears the widget down and builds a new one. Without this, every
deploy silently darkens every BrightSign panel until someone power-cycles it.

**2. It recovers.** `load-error` retries with backoff (5s → 15s → 30s → 60s) and after three
failures falls back to a local page, so a dead server shows something truthful instead of white.
On top of that, a watchdog: the page beats every 30s and three missed beats rebuild the widget.
That covers the case `load-error` never reports — a page that loaded fine and then wedged on a
dead socket, a JS exception, or a stalled decoder.

**3. Identity lives in the registry.** `localStorage` is tied to the page's origin and quota; the
registry survives reboots, content updates and origin changes. The hardware serial is the stable
id, so two panels imaged from the same card never collide — which is exactly how the web player's
hardware-only fingerprint once merged two identical panels into a single device row.

**4. It reaches BrightScript-only capabilities** — video mode, a second output, and native
BrightWall sync — on the page's behalf, over `@brightsign/messageport`.

## Where the files go — card OR internal flash

```
autorun.brs          the host
offline.html         local fallback, used after three failed loads
screentinker.json    optional — server URL, sync backend, output mode
```

**A player will boot `autorun.brs` from internal flash, not just from a card.** Confirmed on real
hardware (XT245, BOS 9.0.189) whose microSD interface is physically dead:

```
Loading 'FLASH:/autorun.brs'
BSPLAY: https://screentinker.com/player?platform=brightsign&serial=…&model=XT245
```

That matters far beyond one broken unit — it means a player with no card, or a failed card slot,
is still fully deployable. Push the files over SFTP to `/storage/flash` (user `brightsign`, blank
password, once SSH is enabled) and reboot.

`StorageRoot()` in `autorun.brs` therefore refuses to assume: it probes for `FLASH:/autorun.brs`
and falls back to `SD:`. Hard-coding `SD:` is exactly the bug that made the first flash boot fail —
the script loaded and then could not find its own `index.html`.

**`st-bridge.js` and `st-sync.js` do NOT go on the card.** The player pulls them from the server
(`/player/st-bridge.js`, `/player/st-sync.js`) so they can never skew from the player that uses
them. A stale copy on a card is precisely the version skew that would leave a panel unable to
restart itself.

## autorun.zip — one file instead of four

`scripts/build-autorun-zip.sh` packages the host, the fallback page and the config into a single
`autorun.zip`, attached to every GitHub release:

```bash
scripts/build-autorun-zip.sh --server https://your-server
```

Drop it on the root of a player's storage and power-cycle. `autozip.brs` unpacks it in place,
renames it `autorun.zip.done` so it never re-extracts, and reboots into the player.

Two rules the format imposes, both of which fail silently if broken:

- **The archive must expand to files at its ROOT**, with no wrapper directory — a player extracts
  to the storage root, so a nested folder puts `autorun.brs` somewhere the player never looks and
  the card appears to do nothing. The build script zips from *inside* the staging directory and
  then asserts the layout rather than trusting it.
- **`autorun.brs` must NOT sit next to `autorun.zip`** on the storage root; its presence stops the
  zip being processed at all. It belongs inside the archive.

The rename is what makes it idempotent. Without it the player extracts, reboots, extracts, reboots
— a loop that looks exactly like a hardware fault. An extraction *failure* deliberately does not
rename, so a truncated copy is retried after someone replaces it rather than skipped forever.

Requires BrightSignOS 7.0.60+ (`roUnzip`).

## Provisioning

Config resolves `screentinker.json` on the card **>** registry **>** built-in default. The JSON
file is how a batch gets imaged without touching each box:

```json
{ "server_url": "https://screentinker.com", "sync_backend": "auto", "output_mode": "single" }
```

## Dual output

`output_mode` is `single` | `dual` | `clone`.

- **dual** — a second widget loads the same player with `&screen=2`, so the server can hand it its
  own playlist. Two independent displays from one player.
- **clone** — the second widget loads `&screen=1`: the same content on both outputs.

Confirmed multi-output: **XC2055** (dual HDMI) and **XC4055** (quad).

⚠️ **Do not trust the series-level spec blurb.** It credits the whole XT5 family — XT245, XT1145,
XT2145 — with "dual HDMI outputs", but an **XT245 in hand is single-output**; that phrase appears
to cover HDMI *in* plus *out*. Verify the individual model before enabling `dual`.

Every other model is single-output, so the second widget is only ever created when the config asks
for it — an unsupported model keeps working as a normal single-screen player rather than failing to
start.

## Synchronisation — ours or theirs

Both, chosen per group. `server/lib/sync-backend.js` decides and `resolveSyncBackend()` is pure,
so the decision is tested without a fleet (`server/test/sync-backend.test.js`).

| backend | reach | accuracy |
|---|---|---|
| `screentinker` | Android, web, Tizen, BrightSign — any mix | to the second; clock-derived, no leader, survives a server outage |
| `brightsign` | BrightSign only | frame-accurate (BrightWall) |

`auto` picks native sync when **every** member is a BrightSign and ours otherwise. Explicit
settings are honoured, with one refusal: native sync selected for a group containing a
non-BrightSign display **downgrades and reports why**. A group that half-syncs is worse than one
that syncs to the second everywhere — and the failure would be invisible from the dashboard,
because the BrightSigns would look perfectly synchronised while the odd panel drifted alone.

A player paired before this port is still recognised, by its BrightSign user agent.

## Command parity

The web player handles four of the ~20 fleet commands — `launch`, `refresh`, `screen_on`,
`screen_off` — because a browser tab genuinely cannot do more. A BrightSign can, through the host
and the platform APIs:

| command | web player | BrightSign |
|---|---|---|
| `screen_on` / `screen_off` | black overlay; panel stays lit | **CEC** Image View On / Standby — the display actually sleeps |
| `reboot` | ignored | **real reboot** via `RebootSystem` in the host |
| `set_volume` | — | applied to current and future media |
| `refresh` | `location.reload()` | widget rebuilt by the host (reload is unreliable here) |

### ⚠️ Nothing in the DOM can cover video

With `hwz_default: "on"` the widget decodes video onto a **hardware plane**, and the graphics plane
— everything in the DOM — sits behind it. Blanking the screen took three attempts on real hardware,
and each failure taught the same lesson from a different angle:

1. **Black overlay** → the video played straight *through* it. A `z-index: 9999` div cannot cover a
   hardware plane.
2. **Pause + hide the element** → playback stopped, but the **last decoded frame stayed on screen**.
   Hiding a DOM element does nothing to the plane; the plane is not part of the DOM.
3. **Pause + `removeAttribute('src')` + `load()`** → releases the plane. Black at last.

Coming back out re-mounts through `nextItem()`, because a torn-down element cannot be resurrected.
The playlist keeps advancing while the screen is off, so each newly started item is torn down too,
caught on the `play` event in the capture phase — otherwise the next video lights the panel back up.

Any feature that assumes an overlay can hide video needs rethinking here: screen blanking, masking,
fades over video.

`displayPower()` (CEC) is best effort and deliberately **not** load-bearing — it returns false when
CEC is unavailable and the media teardown does the real work. Our XT245 reports
`failed to get cec clock` in the kernel log and does not respond to CEC at all, which is exactly why
blanking must not depend on it. Plenty of displays ignore broadcast CEC or need direct addressing. Volume is re-applied on every `play` event in the capture phase, because
media elements are created per item across several code paths and setting it once would otherwise
last only until the playlist advanced.

Still Android-only, and correctly inert here: the Tier-2 device-owner commands (`kiosk_lock`,
`install_apk`, `shell`, `block_uninstall`, …) and `set_brightness` / `set_screen_timeout`, which
have no BrightSign equivalent — a signage player has no per-window brightness or screen timeout.

## What is NOT done yet

Stated plainly so nobody reads this as finished:

- **No server-side plumbing**: no `sync_backend` column, no dashboard control, nothing sends
  `set-sync-backend` down, and nothing consumes the `bs_model` / `bs_serial` / `bs_screen` fields
  the player now reports. The resolver is ready for all of it.
- **Native sync is implemented but not yet driven by the playlist engine.** `st-sync.js` wraps
  SyncManager and is tested (`server/test/brightsign-sync.test.js`), but nothing in the player
  calls `announce()` on item advance or binds `attachVideo()` yet, and no leader is designated.
  That wiring is the next step and wants hardware to validate.

  ```js
  const SyncManager = require('@brightsign/syncmanager');          // BrightSignOS 8.2.10+
  const sync = new SyncManager('', 'ScreenTinkerSync', '224.0.126.10', 1539);
  sync.leader = true;                                              // followers just omit this
  sync.addEventListener('syncevent', (e) => {                      // BOTH roles listen
    if (e.id === lastId) return;                                   // 1Hz rebroadcast — dedupe!
    lastId = e.id;
    video.setSyncParams(e.domain, e.id, e.iso_timestamp);          // extension on <video>
    video.load(); video.play();
  });
  sync.synchronize('item_' + Date.now(), 1000);                    // leader only; msDelay to prep
  ```

  Three properties that shaped the design: it is **leader/follower** where ours is leaderless (and
  the leader starts from its OWN broadcast, or it runs ahead of the group); it synchronises
  **video only**, so images and widgets get item-boundary alignment at best; and it is
  **multicast**, so the whole group must share one L2 network — the resolver now treats differing
  subnets as evidence against it.

  Also: MP4/MOV are fine, MPEG-TS needs its presentation timestamp starting at 0, MPEG-PS is
  unsupported. `synchronize()` rebroadcasts at 1Hz so late-powered players still join, which is
  why the dedupe above is mandatory rather than an optimisation — without it every player reloads
  its video once a second, forever.
- **Addressing a specific HDMI connector from JS is unverified.** `@brightsign/videooutput`
  documents `setMode({width,height,refreshRate})` with no output index. Dual output above assumes
  a second widget maps to the second connector; that needs hardware confirmation.
- **Registry from a remote origin is still unproven** — the original probe question. If injection
  turns out to be origin-dependent, identity moves to a local shim page that owns the registry and
  passes it to the hosted player in an iframe via `postMessage`.
- **Nothing here has run on hardware.** It is written against the BrightDeveloper docs and
  checked line-by-line against the `brightsign/dev-cookbook` examples, which corrected four
  config keys, the registry API and a hard SyncManager requirement (see below).

## Verified against the dev-cookbook

`autorun.brs` and `st-bridge.js` were reviewed against the real examples rather than the prose:

- **`brightsign_js_objects_enabled: true` is required** alongside `nodejs_enabled` for
  `require("@brightsign/*")` (`syncmanager-js/autorun.brs`). Without it the bridge degrades to
  no-ops and the player silently loses identity *and* restart delegation — the failure would look
  like "BrightSign just doesn't work" rather than a missing flag.
- **`storage_path` is a directory name** (`"/cache"`), not a volume, and **`storage_quota` is a
  string** (`indexeddb-caching/autorun.brs`).
- **`security_params: { websecurity: true }`** and `hwz_default: "on"` are the shapes the examples
  use; local URLs carry the volume (`file:/SD:/index.html`).
- **The registry API is asynchronous and section-oriented**: `read(section, key)` returns a
  **Promise** and writes take an object — `write(section, {k: v})`. The bridge prefetches into a
  cache and exposes `onReady()`; the player waits for it before its first connect, because
  registering early would pair the panel as a new display and strand its real row.
- **SyncManager needs `networking/ptp_domain = "0"`, applied by a reboot**
  (`syncmanager-js/autorun.brs`). Done only when this player is configured for native sync, and
  read-before-write so it reboots at most once rather than every boot.
- Confirmed correct as written: `@brightsign/messageport` (`new`, `addEventListener('bsmessage')`,
  `PostBSMessage`), the `roHtmlWidgetEvent` loop, and `RebootSystem()`.
- The notes state a widget URL may be **"an externally hosted page"** with the same access to the
  BrightSign JS APIs, which is the answer the original probe was built to get — still worth
  confirming on hardware, but the documented answer is the favourable one.

## Model notes

Target **Series 5** (Chromium 120) or newer. **Series 4 is pinned to Chromium 87**, and Series 4
and older have fixed graphics/JS memory splits (XTx43/44: 512MB/512MB; HDx23: 256MB/128MB) where
Series 5 allocates dynamically. Image size defaults to 2048x1280x32bpp (3840x2160 on XT/4K models)
and is raised with `roVideoMode.SetImageSizeThreshold()`.
