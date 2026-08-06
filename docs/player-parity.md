# Player parity matrix

What each player can actually do, verified against the code rather than assumed. This is the
document that says where the remaining work is, so a wrong "yes" here is worse than a missing row:
it puts a control on the dashboard that cannot work.

Capability names come from `server/lib/player-capabilities.js`. Players declare their own set at
registration; a player that declares nothing falls back to the per-platform baseline in that file.

**Legend** — ✅ supported · ⚠️ partial/conditional (reason given) · ❌ not supported (reason given)

BrightSign runs the *same* `server/player/index.html` as the browser, so it differs only where the
`autorun.brs` host bridge adds something the browser cannot reach.

## Playback

| capability | Android | Web | Tizen | BrightSign |
|---|---|---|---|---|
| `playback.video` | ✅ ExoPlayer | ✅ `<video>` | ✅ AVPlay | ✅ hardware plane |
| `playback.image` | ✅ | ✅ | ✅ | ✅ |
| `playback.widget` | ✅ WebView | ✅ iframe | ✅ iframe | ✅ iframe |
| `playback.youtube` | ✅ WebView embed | ✅ IFrame API | ✅ iframe embed | ✅ IFrame API |
| `playback.zones` | ✅ | ✅ | ✅ | ✅ |
| `playback.transitions` | ✅ GL wipes (#204) | ⚠️ declared only when the bundle loads — a failed load hard-cuts rather than breaking playback | ✅ | ⚠️ as web |
| `playback.pip` | ✅ `PipOverlay` | ✅ `#pipContainer` | ✅ | ✅ |

## Audio

| capability | Android | Web | Tizen | BrightSign |
|---|---|---|---|---|
| `audio.mute` | ✅ incl. YouTube via IFrame bridge | ✅ | ✅ incl. YouTube via `postMessage` | ✅ as web |
| `audio.volume` | ✅ `set_volume` | ✅ `set_volume` | ❌ **no `set_volume` handler exists** — the dashboard slider does nothing today | ✅ as web |

## Display

| capability | Android | Web | Tizen | BrightSign |
|---|---|---|---|---|
| `display.rotation` | ✅ native `rootView.rotation` | ✅ CSS transform | ✅ CSS + AVPlay for video | ⚠️ host rotates the output via `roVideoMode`; CSS alone cannot turn the hardware video plane |
| `display.power` | ✅ `screen_off` / `lock_now` | ❌ a browser tab cannot power a panel — the overlay only paints black | ❌ `screen_off` draws a black overlay, deliberately, "so the command still does something visible" | ⚠️ media teardown always works; CEC is best-effort and absent on some units |
| `display.resolution` | ❌ no video-mode control in the app | ❌ not addressable from a browser | ❌ | ✅ `roVideoMode` via the host |

## Remote view and control

| capability | Android | Web | Tizen | BrightSign |
|---|---|---|---|---|
| `remote.screenshot` | ⚠️ view capture always; full-screen only with accessibility or MediaProjection | ⚠️ canvas only — same-origin content, and the alpha probe rejects frames where no pixels arrived | ✅ `captureAndSend` | ⚠️ host framebuffer capture **requires primary storage**; falls back to canvas, which cannot read the video plane |
| `remote.stream` | ✅ | ✅ 1fps | ✅ | ⚠️ as web |
| `remote.input` | ✅ | ✅ | ✅ | ✅ |

## Lifecycle

| capability | Android | Web | Tizen | BrightSign |
|---|---|---|---|---|
| `system.restart_player` | ✅ | ✅ `location.reload()` | ✅ | ✅ host rebuilds the widget — a page reload does not reliably return |
| `system.reboot` | ✅ device owner | ❌ a browser tab cannot reboot its host | ❌ no Tizen API exposed to the app | ✅ `RebootSystem()` via the host |
| `system.self_update` | ✅ APK OTA (`UpdateChecker`) | ❌ the server deploys the player; there is nothing for it to update | ❌ `.wgt` updates go through Tizen's own store/CLI | ✅ `autorun.zip` package update |

## Device management

Android device-owner territory. Everything here is ❌ elsewhere for the same reason — no equivalent
privilege model exists on those platforms — so the column is collapsed.

| capability | Android | Web / Tizen / BrightSign |
|---|---|---|
| `system.kiosk` | ✅ lock-task, now persisted across reboot | ❌ no device-owner concept |
| `system.brightness` | ✅ Tier 0/1 | ❌ |
| `system.screen_timeout` | ✅ Tier 1 | ❌ |
| `system.install_apk` | ✅ Tier 2 | ❌ not an APK platform |
| `system.shell` | ✅ Tier 2, handled in `WebSocketService` | ❌ |
| `system.time` | ✅ Tier 2 | ❌ |

## Synchronisation and resilience

| capability | Android | Web | Tizen | BrightSign |
|---|---|---|---|---|
| `sync.clock` | ✅ | ✅ | ✅ | ✅ |
| `sync.native` | ❌ no native protocol | ❌ | ❌ | ⚠️ SyncManager, BOS 8.2.10+; multicast so all members must share one L2 network |
| `offline.cache` | ✅ content downloaded to disk, **resumable** (Range + If-Range), revision-keyed | ✅ service worker, **resumable chunked prefetch**, revision-keyed | ✅ **media cached to `wgt-private`** (`js/media-cache.js`), resumable, revision-keyed — declared at runtime | ⚠️ **depends on the host widget's storage config — see below** |

---

## Real gaps worth closing

Ordered by how visible the failure is to an operator.

1. **Tizen `audio.volume` — dead control.** `set_volume` has no handler in `tizen/js/app.js`; the
   only volume path is the on-device `KEYCODE_VOLUME_*` keys. The dashboard slider silently does
   nothing. Either implement the handler or let the capability hide the control.
2. ~~**Tizen `offline.cache` is partial.**~~ **Closed.** `tizen/js/media-cache.js` caches the
   media itself to `wgt-private` — resumable, so a panel on a bad link accumulates an asset
   across attempts instead of restarting from zero, and revision-keyed, so a replaced asset is
   still a miss. The capability is declared at runtime rather than assumed: a build that cannot
   write to private storage keeps quiet about it.
3. **BrightSign offline caching is NOT automatic — it depends on who created the widget.** A real
   XT245 on alpha exposes `navigator.serviceWorker`, and then never even fetches `sw.js`:
   registration is refused, so there is no worker, no content cache and no offline playback. That
   unit is running **BSN's Supervisor** (`autorun.createdby = Supervisor 2.1.18.3`) rather than our
   `brightsign/autorun.brs`, and Supervisor's widget has no `storage_path` — the setting our own
   host script does set (`storage_path: "/cache"`, `storage_quota: "1073741824"`), and the
   precondition for a widget having persistent storage at all. So this is very likely a widget
   CONFIG issue rather than a platform limit, but **it is unverified on hardware**: nobody has yet
   watched a player running our package register a worker.

   The player no longer lies about it either way — `offline.cache` is declared only when a worker
   is genuinely in control, and a refused registration reports `app_error/sw_unavailable` to the
   server instead of a `console.warn` on a display nobody has a console for.

3. **BrightSign `remote.screenshot` needs primary storage.** Reachable today only via the canvas
   fallback, which cannot read the video plane, so screenshots show everything except the video.
   Resolves itself when a card or SSD is fitted.
4. **`display.resolution` is BrightSign-only.** Fine, but the dashboard should not offer it
   elsewhere.

## Correctly impossible — do not "fix" these

- **`system.reboot` on web/Tizen.** No API exists. A browser tab rebooting its host would be a
  browser vulnerability.
- **`display.power` on web.** The overlay is the honest maximum; the panel stays lit.
- **All of device management off Android.** No equivalent privilege model exists on Tizen or
  BrightSign, and a web player has no device to manage.
- **`system.self_update` on web.** The player *is* the deployment; there is nothing to update.
- **`sync.native` off BrightSign.** It is BrightSign's own protocol, and the clock-derived one is
  the cross-platform answer that already works everywhere.

## ⚠️ Corrections needed in `player-capabilities.js`

Found while verifying this table. The baselines only apply to displays that declare nothing, so
these are wrong for the existing fleet until each player ships its declaration:

- **`tizen` claims `audio.volume`** — no handler exists (gap 1 above). Should be removed.
- **`tizen` omits `remote.screenshot` and `remote.stream`** — both are implemented
  (`captureAndSend`, `startStreaming`). Should be added.
- **`tizen` declares `offline.cache` itself now** — the server baseline still omits it, which is
  correct: a fielded panel that has not been updated genuinely cannot hold media, and the
  baseline describes what an un-updated one can do.
