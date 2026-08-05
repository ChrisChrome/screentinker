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
| `probe.html` | The original capability probe. Still useful on a new model/OS build. |
| `offline.html` | Local fallback page — see recovery below. **Not yet written.** |

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

Multi-output models are **XC2055** (dual HDMI), **XC4055** (quad), and **XT245 / XT1145 / XT2145**
(dual HDMI, dual 4K60p simultaneous). Every other model is single-output, so the second widget is
only ever created when the config asks for it — an unsupported model keeps working as a normal
single-screen player rather than failing to start.

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

## What is NOT done yet

Stated plainly so nobody reads this as finished:

- **`offline.html` is not written.** The host references it as the fallback page.
- **The player does not yet load `st-bridge.js` or honour `?platform=brightsign`.** The bridge and
  the resolver exist and are tested; wiring them into `index.html` (identity, restart-instead-of-
  reload, sync backend) is the next commit.
- **No server-side plumbing**: no `sync_backend` column, no dashboard control, nothing sends
  `set-sync-backend` down. The resolver is ready for it.
- **The `brightsign` backend is a resolved decision, not yet an implementation.** The API is now
  known (it was not in the MCP doc set — `part-6-appendices/api-reference.md` is a stub — but
  `docs.brightsign.biz/developers/syncmanager` and the `brightsign/dev-cookbook`
  `examples/browser/syncmanager-js` example document it fully):

  ```js
  const SyncManager = require('@brightsign/syncmanager');          // BrightSignOS 8.2.10+
  const sync = new SyncManager('', 'BrightSignDomain', '224.0.126.10', 1539);
  sync.leader = true;                                              // followers just omit this
  sync.addEventListener('syncevent', (e) => {                      // BOTH roles listen
    if (e.id === lastId) return;                                   // 1Hz rebroadcast — dedupe!
    lastId = e.id;
    video.setSyncParams(e.domain, e.id, e.iso_timestamp);          // extension on <video>
    video.load(); video.play();
  });
  sync.synchronize('item_' + Date.now(), 1000);                    // leader only; msDelay to prep
  ```

  Good news for the port: it is **pure JavaScript on the standard `<video>` element**, so it
  needs no BrightScript round-trip and drops into the existing player. Three things it implies:

  1. **It is leader/follower**; ours is leaderless. A group using it needs a designated leader.
  2. **It is a video mechanism.** `setSyncParams` is on the video element, so images and widgets
     get item-boundary alignment at best, where ours covers every item type.
  3. **Multicast means one L2 network.** A group spanning sites or VLANs cannot use it, which is
     a selection criterion the resolver does not model yet.

  Also: MP4/MOV are fine, MPEG-TS needs its presentation timestamp starting at 0, MPEG-PS is
  unsupported. Followers accept only the first message per id, and `synchronize()` rebroadcasts
  at 1Hz so late-powered players still join — which is exactly why the dedupe above is mandatory
  rather than an optimisation.
- **Addressing a specific HDMI connector from JS is unverified.** `@brightsign/videooutput`
  documents `setMode({width,height,refreshRate})` with no output index. Dual output above assumes
  a second widget maps to the second connector; that needs hardware confirmation.
- **Registry from a remote origin is still unproven** — the original probe question. If injection
  turns out to be origin-dependent, identity moves to a local shim page that owns the registry and
  passes it to the hosted player in an iframe via `postMessage`.
- **Nothing here has run on hardware.** It is written against the BrightDeveloper docs.

## Model notes

Target **Series 5** (Chromium 120) or newer. **Series 4 is pinned to Chromium 87**, and Series 4
and older have fixed graphics/JS memory splits (XTx43/44: 512MB/512MB; HDx23: 256MB/128MB) where
Series 5 allocates dynamically. Image size defaults to 2048x1280x32bpp (3840x2160 on XT/4K models)
and is raised with `roVideoMode.SetImageSizeThreshold()`.
