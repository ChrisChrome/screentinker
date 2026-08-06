# Player parity matrix

What each player can actually do, verified against the code rather than assumed. This is the
document that says where the remaining work is, so a wrong "yes" here is worse than a missing row:
it puts a control on the dashboard that cannot work.

Capability names come from `server/lib/player-capabilities.js`. Players declare their own set at
registration; a player that declares nothing falls back to the per-platform baseline in that file.

**Legend** — ✅ verified in source · ⚠️ partial/conditional (reason given) · ❌ not supported (reason
given) · 💀 **dead**: the capability is declared or baselined but the control cannot work · ❓
**unverifiable from source** — needs hardware, and is marked as such rather than asserted.

BrightSign runs the *same* `server/player/index.html` as the browser, so it differs only where the
`autorun.brs` host bridge adds something the browser cannot reach. The bridge has two halves: the
JS (`brightsign/st-bridge.js`, served by us at `/player/st-bridge.js`, always current) and the
on-device BrightScript that must create the widget with `nodejs_enabled:true`. `BS.hasHost()` is
false unless BOTH are present, and everything host-backed hangs off it.

Verified at `2237eda`. Where a row cites "the fielded build" it means `v1.9.28` — the last release
before any player declared anything, and therefore the build every baseline is describing.

---

## 🔴 Read this first: three dead controls found by this audit

These are not gaps in coverage. They are controls a customer can press today that do nothing.

### 1. The volume slider works on Android only

`frontend/js/views/device-detail.js` sends `set_volume` as **`{ level: 0..1 }`**:

```js
el?.addEventListener('change', () => sendCommand(device.id, cmd, { level: parseInt(el.value, 10) / 100 }));
```

| player | what the handler reads | result |
|---|---|---|
| Android | `payload.optDouble("level", -1.0)` | ✅ works |
| web | `data.payload?.value ?? data.value` | 💀 `undefined` → `isFinite` fails → silent no-op |
| Tizen | `payload.value ?? payload.volume` | 💀 `undefined` → logs `no usable value in payload` |
| BrightSign | (the web player) | 💀 as web |

Three of the four players have a complete, working volume implementation that cannot be driven,
because nobody checked the payload key against the sender. **Fix: one line in
`server/player/index.html` and one in `tizen/js/app.js` — accept `level` (0..1) as well.** Until
then `audio.volume` has been removed from the `web` and `brightsign` baselines, and
`test/player-parity-baselines.test.js` holds that as a **biconditional**: fix the player and the
test fails, telling you to put the baseline entry back.

### 2. Every #161 Tier-2 command was refused for the entire fleet — FIXED here

`lock_now`, `power_menu`, `status_bar`, `block_uninstall` and `unblock_uninstall` were gated on
`system.device_owner`. **No player declares that name** — not `PlayerCapabilities.kt`, not
`tizen/js/capabilities.js`, not `declaredCapabilities()`, not `st-bridge.js` — and no baseline
granted it. So `supports()` returned false for every device on every platform and all five commands
were refused, *including on the device-owner panels the whole feature was built for*. The dashboard
still drew the buttons, because `device-detail.js` gates that block on `device.tier === 2 ||` too,
so an operator on a real owner panel pressed "Lock now" and got a silent server-side refusal.

Fixed in `player-capabilities.js`: those five now accept `system.device_owner` **or**
`system.kiosk`. That is an exact stand-in, not a loose one — `PlayerCapabilities.kt` declares
`system.kiosk` under `if (isOwner)` and nothing else, which is precisely when `STPolicy`'s `owned()`
actions do anything, and no non-Android player declares it.

**Follow-up owned by Android:** `PlayerCapabilities.kt` should declare `system.device_owner` under
`if (isOwner)`, at which point the stand-in becomes redundant.

### 3. The capture bootstrap required the capability it creates — half FIXED here

`enable_system_capture` raises Android's MediaProjection consent dialog: it is how a panel *gains*
full-screen capture. It was gated on `remote.screenshot`, so the only panel that needs it — no
accessibility, no projection grant, therefore no declared `remote.screenshot` — was the one panel
that could not be sent it. The command is now ungated.

**Still broken, and it is a frontend change:** `device-detail.js` renders the button behind
`can('remote.screenshot')`, so it is still hidden on exactly those panels.

---

## Playback

No command routes to any `playback.*` capability and no dashboard control is gated on one, so these
describe content rendering. They are informational, and shown to the operator in the Info tab.

| capability | Android | Web | Tizen | BrightSign |
|---|---|---|---|---|
| `playback.video` | ✅ ExoPlayer (`MediaPlayerManager`) | ✅ `<video>` | ✅ AVPlay | ✅ hardware plane |
| `playback.image` | ✅ `ImageLoader` | ✅ | ✅ | ✅ |
| `playback.widget` | ✅ WebView | ✅ iframe | ✅ iframe | ✅ iframe |
| `playback.youtube` | ✅ WebView embed | ✅ IFrame API | ✅ iframe embed | ✅ IFrame API |
| `playback.zones` | ✅ `ZoneManager` | ✅ | ✅ | ✅ |
| `playback.transitions` | ✅ `TransitionCompositor` | ⚠️ declared only when the bundle loads (`transitionRuntimeReady()`) — a failed load hard-cuts rather than breaking playback | ✅ `transitions.js` | ⚠️ composites DOM over video; with hwz it may be **invisible over video** and degrade to a hard cut |
| `playback.pip` | ✅ `PipOverlay` | ✅ `#pipContainer` | ✅ `pip-overlay.js` | ⚠️ same hwz caveat as transitions |

## Audio

| capability | Android | Web | Tizen | BrightSign |
|---|---|---|---|---|
| `audio.mute` | ✅ `device:mute-changed` → `setVideoMuted`, incl. YouTube via the IFrame bridge | ✅ | ✅ incl. YouTube via `postMessage` | ✅ as web |
| `audio.volume` | ✅ `set_volume` reads `payload.level` | 💀 reads `payload.value`; dashboard sends `level` | 💀 handler exists (`applyVolume`, incl. `tizen.tvaudiocontrol`) and reads `payload.value` | 💀 as web |

## Display

| capability | Android | Web | Tizen | BrightSign |
|---|---|---|---|---|
| `display.rotation` | ✅ native `rootView.rotation` — the ExoPlayer surface rotates with it | ✅ CSS transform | ✅ CSS + AVPlay `setDisplayRotation` for video | ⚠️ CSS cannot turn the hardware video plane; the host would have to (`roVideoMode`), and the page never calls `BS.setVideoMode` |
| `display.power` | ⚠️ conditional. `screen_off` needs owner / device-admin FORCE_LOCK / accessibility; `screen_on` is a **wake lock**, which works anywhere — but only since `812e89f`. On the fielded build `screen_on` is a logged no-op, which is why the Android baseline no longer claims this | ❌ a browser tab cannot power a panel — the overlay only paints black | ✅ both halves on every build, no signing needed: `showScreenOff()` / `clearScreenOff()`, plus the real panel API where `STDeviceControl` finds one | ⚠️ needs `hasHost()`. Media teardown always blanks; ❓ **CEC is unverified** — our XT245 resolves `@brightsign/cec` while the kernel logs `failed to get cec clock` and the display never responds |
| `display.resolution` | ❌ needs system/root | ❌ not addressable from a browser | ❌ no web-accessible mode setting on the TV profile | ⚠️ **declared but unreachable** — `st-bridge.js` exposes `setVideoMode`, the page never calls it, and no command maps to this capability |
| `display.brightness` (per-window dim, Tier 0) | ✅ `set_brightness` → `setWindowBrightness`, no privilege needed | ❌ | ❌ | ❌ |

⚠️ `PlayerCapabilities.kt` **does not declare `display.brightness`**, though `MainActivity` handles
`set_brightness` unconditionally. So an *updated* Android panel loses the per-window dim slider that
an un-updated one keeps via the baseline. See gap 2.

## Remote view and control

| capability | Android | Web | Tizen | BrightSign |
|---|---|---|---|---|
| `remote.screenshot` | ⚠️ `captureView` always (a real frame of the player's own view); full-screen only with accessibility or MediaProjection. Declared **only** for the full-screen path | ⚠️ canvas only — same-origin content, and the alpha probe rejects frames where no pixels arrived | ⚠️ `captureAndSend` captures **images only**; video and YouTube get an honest status card reading "Live preview unavailable for video / YouTube on Tizen" | ⚠️ `st-bridge.js` gates host framebuffer capture on **primary storage**; without a disk it falls back to canvas, which cannot read the video plane |
| `remote.stream` | ✅ | ✅ 1fps | ✅ 1s interval over `captureAndSend`, so the same image-only limit | ⚠️ as web |
| `remote.input` | ✅ `TouchInjector` — plain `dispatchTouchEvent`, no privilege | ✅ | ✅ `elementFromPoint().click()` + D-pad/volume keys | ✅ synthesised DOM events, needs no host |

## Lifecycle

| capability | Android | Web | Tizen | BrightSign |
|---|---|---|---|---|
| `system.restart_player` | ✅ `launch` / `refresh` | ✅ `location.reload()` | ✅ `location.reload()` via `STDeviceControl` | ⚠️ needs `hasHost()` so the host rebuilds the widget. **A page-initiated reload does not reliably bring an roHtmlWidget back** — that darkened a customer's panel on 2026-07-28, which is why neither `st-bridge.js` nor the baseline offers this without a host |
| `system.reboot` | ⚠️ **device owner only** (`STPolicy.reboot()`). Off-owner it degrades to an accessibility power *dialog*, which needs someone at the screen | ❌ a browser tab cannot reboot its host | ⚠️ only on a **partner-signed** panel where `STDeviceControl.capabilities().reboot` is true | ⚠️ `RebootSystem()` via the host |
| `system.self_update` | ✅ APK OTA (`UpdateChecker`), and `update` forces a check | ❌ the server deploys the player; there is nothing for it to update | ❌ a `.wgt` is installed by the panel, not the app | 💀 **for the dashboard button.** The host really does self-update — `autorun.brs` polls `CheckPackageUpdate` every `PKG_CHECK_MS` — but that is a host-side poll on a socket it is not listening to. The page declares `system.self_update` behind `hasHost()`, the dashboard renders "Force update", and `index.html` has **no `update` branch at all**. See gap 3 |

## Device management

Android device-owner territory. Everything here is ❌ elsewhere for the same reason — no equivalent
privilege model exists on those platforms — so the column is collapsed. Tizen and BrightSign both
decline these explicitly and in writing in their own capability modules.

| capability | Android | Web / Tizen / BrightSign |
|---|---|---|
| `system.kiosk` | ⚠️ owner-only. Off-owner `startLockTask()` is screen pinning, which prompts — unusable on a panel with no input | ❌ no device-owner concept |
| `system.brightness` | ⚠️ `WRITE_SETTINGS` **or** owner (`setSystemSetting`) | ❌ |
| `system.screen_timeout` | ⚠️ same gate as above | ❌ |
| `system.install_apk` | ⚠️ owner **or** a foreign DPC that delegated the install scope | ❌ not an APK platform |
| `system.shell` | ✅ declared unconditionally — it is an **app-UID** `sh -c`, not root, so it works at any tier. Handled in `WebSocketService` | ❌ |
| `system.time` | ⚠️ owner-only | ❌ |
| `system.device_owner` | 💀 **declared by nobody.** See the red section above | ❌ |

## Synchronisation and resilience

| capability | Android | Web | Tizen | BrightSign |
|---|---|---|---|---|
| `sync.clock` | ✅ `GroupScheduleController` | ✅ | ✅ `syncedNow()` + `schedule-eval.js` | ✅ as web |
| `sync.native` | ❌ no native protocol | ❌ | ❌ | ⚠️ `st-sync.js` / SyncManager, gated on module presence **and** BOS 8.2.10+ (below the floor the module can resolve and silently do nothing, which on a wall means every panel reports healthy while drifting). ❓ **unverified on hardware** |
| `offline.cache` | ✅ `ContentCache` + `DownloadCoordinator`, resumable (Range/If-Range), revision-keyed | ✅ service worker, resumable chunked prefetch, revision-keyed; declared only when a worker is genuinely **controlling** the page | ⚠️ `js/media-cache.js` caches media to `wgt-private` — **new at HEAD**, absent from the fielded build, and declared at runtime only where the platform grants storage | ❓ **unverified.** See gap 4 |

---

## Where the four declaration sites disagree with each other

| | Android | Web | Tizen | BrightSign |
|---|---|---|---|---|
| declaration site | `telemetry/PlayerCapabilities.kt` | `declaredCapabilities()` in `index.html` | `js/capabilities.js` | **`index.html` again** |

⚠️ **`brightsign/st-bridge.js` `computeCapabilities()` IS DEAD CODE.** It is exported as
`BS.capabilities`, and nothing calls it: `grep -n "BS\.[a-zA-Z]*(" server/player/index.html` lists
23 bridge calls and `capabilities` is not among them. The BrightSign declaration actually comes
from the web player's `declaredCapabilities()`, and the two disagree substantially:

| capability | `st-bridge.js` says | `index.html` actually declares | which is right |
|---|---|---|---|
| `offline.cache` | `navigator.serviceWorker` **exists** | a worker is **controlling** the page | index.html. The bridge's version is the exact lie that shipped on the XT245 |
| `remote.screenshot` | needs `probe.storage_present` | any 2d canvas | the bridge. A canvas cannot read the video plane |
| `remote.stream` | needs `probe.storage_present` | unconditional | the bridge |
| `system.self_update` | needs `probe.storage_present` | needs `hasHost()` | the bridge — staging `autorun.zip` needs a volume |
| `display.rotation` | needs a host (`roVideoMode`) | unconditional (CSS) | the bridge, for video |
| `display.power` | needs `CecClass` | needs `hasHost()` | roughly equivalent |
| `display.resolution` | host **or** `VideoOutputClass` | needs `hasHost()` | the bridge |
| `system.restart_player` | needs a host | unconditional | the bridge — see the 2026-07-28 incident |
| `sync.native` | module **and** OS ≥ 8.2.10 | `ScreenTinkerBSSync.available()`, which is **module presence only** | the bridge. `index.html` skips the firmware floor |

**`server/test/brightsign-capabilities.test.js` is 199 lines of thorough tests for this dead
function.** Every one passes, and none of them constrains what a BrightSign actually declares. That
is worse than no coverage: it reads as proof.

The fix is small and belongs to whoever owns those files — have `declaredCapabilities()` return
`BS.capabilities()` when `BS.isBrightSign()`, and the storage/firmware gating that was already
written and tested starts being true.

---

## Real gaps worth closing

Prioritised by how visible the failure is to an operator. **None of these are implemented here** —
other agents own the player files.

| # | gap | difficulty | why it matters |
|---|---|---|---|
| 1 | **`set_volume` payload mismatch** (`server/player/index.html`, `tizen/js/app.js`) — accept `level` (0..1) alongside `value` (0..100). | **trivial** — one line each | The volume slider is dead on 3 of 4 players. Highest visibility, lowest cost in the list. |
| 2 | **`PlayerCapabilities.kt` under-declares.** Add `display.brightness` (Tier 0, `setWindowBrightness`, always available) and `system.device_owner` under `if (isOwner)`. | **trivial** | Updating an Android panel currently *loses* it the per-window dim slider, and keeps the Tier-2 stand-in in `player-capabilities.js` necessary. |
| 3 | **BrightSign "Force update" is a dead button.** `index.html` has no `update` branch; the host self-updates on its own poll. Either handle `update` by posting a bridge message that triggers `CheckPackageUpdate` now, or stop declaring `system.self_update`. | **small** (a bridge message + a BrightScript branch) | The button is rendered on every host-bridged BrightSign and does nothing. |
| 4 | **`declaredCapabilities()` should defer to `BS.capabilities()` on BrightSign.** | **small** | Turns 199 lines of already-written, already-passing tests from decoration into enforcement, and fixes six wrong declarations at once — including `offline.cache`, the one that shipped a lie to a real customer panel. |
| 5 | **The capture-bootstrap button is hidden where it is needed** (`device-detail.js`, `can('remote.screenshot')`). Render it whenever the device is Android and lacks `remote.screenshot`. | **small** | Server-side gating is fixed; the UI half is not. |
| 6 | **Tizen `remote.screenshot` is images-only.** Video and YouTube return a status card. AVPlay has no readable surface for a canvas. | **hard**, possibly impossible | Honest today, but an operator checking a video panel gets a card instead of a picture. |
| 7 | **BrightSign transitions/PiP over video.** DOM composited over a hwz hardware plane may be invisible. The likely fix is `roVideoMode.SetGraphicsZOrder("front")`, deliberately not applied blind. | **medium**, ❓ **needs hardware** | Changing z-order blind risks hiding video entirely on a player that currently works. |
| 8 | **BrightSign offline caching is unproven either way.** See below. | ❓ **needs hardware** | |

### The BrightSign `offline.cache` question, stated honestly

A real XT245 on alpha exposes `navigator.serviceWorker`, and then never even fetches `sw.js`:
registration is refused, so there is no worker, no content cache and no offline playback. That unit
runs **BSN Supervisor** (`autorun.createdby = Supervisor 2.1.18.3`) rather than our
`brightsign/autorun.brs`, and Supervisor's widget has no `storage_path` — the setting our own host
script does set (`storage_path: "/cache"`, `storage_quota: "1073741824"`) and the precondition for a
widget having persistent storage at all.

So this is *very likely* a widget CONFIG issue rather than a platform limit. **It is unverified: no
one has yet watched a player running our package register a worker.** Until someone has, this
document does not claim it, the `brightsign` baseline does not grant it, and the player declares it
only when a worker is genuinely in control — a refused registration reports
`app_error/sw_unavailable` to the server rather than a `console.warn` on a display nobody has a
console for.

## Correctly impossible — do not "fix" these

- **`system.reboot` on web.** No API exists. A browser tab rebooting its host would be a browser
  vulnerability.
- **`display.power` on web.** The overlay is the honest maximum; the panel stays lit.
- **Device management off Android.** No equivalent privilege model exists on Tizen or BrightSign,
  and a web player has no device to manage.
- **`system.self_update` on web.** The player *is* the deployment; there is nothing to update.
- **`sync.native` off BrightSign.** It is BrightSign's own protocol, and the clock-derived one is
  the cross-platform answer that already works everywhere.
- **`display.resolution` off BrightSign.** No other platform exposes mode setting to an app.

---

## Baselines: what an un-updated display is assumed to be able to do

~446 fielded displays declare nothing and fall back to `BASELINE` in
`server/lib/player-capabilities.js`. Because v1.9.29 is the first build in which *any* player
declares anything, every display reading a baseline is running **v1.9.28 or older by construction**
— so each entry below is justified against `git show v1.9.28:<player source>`, not against HEAD.

`server/test/player-parity-baselines.test.js` pins these to the player sources.

### Corrections made in this pass

| baseline | change | evidence |
|---|---|---|
| `android` | **removed `display.power`** | v1.9.28 `MainActivity`: `"screen_on" -> Log.w("no privileged wake path on a non-rooted panel — no-op")`. The ON half is dead on 100% of fielded panels, and one capability renders **both** buttons. |
| `android` | **removed `system.reboot`** | `STPolicy.reboot()` requires device owner; off-owner v1.9.28 shows the accessibility power *dialog* — which on the accessibility-enabled panels common in this fleet paints that dialog **over the signage**. Owner provisioning is unreleased (#161 / PR #168 still open), so "device owner AND pre-1.9.29" is effectively an empty set. |
| `tizen` | **added `display.power`** | v1.9.28 `app.js` implements both halves with no signing and no panel API: `showScreenOff()` / `clearScreenOff()` + `keepAwake()`. Unlike Android, neither half is privilege-gated. Withholding it hid a working control on every Tizen panel. |
| `web` | **removed `audio.volume`** | v1.9.28 `index.html` contains the string `set_volume` **zero** times, and HEAD's handler reads the wrong payload key. |
| `brightsign` | **removed `audio.volume`, `display.power`, `system.reboot`, `system.restart_player`, `offline.cache`** | All five need a host bridge (`hasHost()`) or a service worker that a Supervisor-built widget refuses. `system.restart_player` is the 2026-07-28 panel-blackout path. `offline.cache` is the documented lie this whole model exists to stop. |

### Consequence, deliberately accepted

`server/services/scheduler.js` gates the nightly scheduled reboot on `system.reboot`. Removing it
from the Android baseline means scheduled reboots now **no-op for undeclared Android panels**
instead of logging `scheduled reboot fired` for a panel that never rebooted. That log line is the
stated reason the gate exists; skipping is the honest answer, and an owner panel on v1.9.29+
declares `system.reboot` for itself and is unaffected.

### The resulting baselines

| capability | android | tizen | brightsign | web |
|---|---|---|---|---|
| `playback.*` (all 7) | ✅ | ✅ | ✅ | ✅ |
| `audio.mute` | ✅ | ✅ | ✅ | ✅ |
| `audio.volume` | ✅ | ❌ no handler in v1.9.28 | ❌ payload | ❌ no handler in v1.9.28 |
| `display.rotation` | ✅ | ✅ | ⚠️ graphics only | ✅ |
| `display.power` | ❌ `screen_on` is a no-op | ✅ | ❌ needs host | ❌ |
| `display.brightness` | ✅ Tier 0, since v1.9.10 | ❌ | ❌ | ❌ |
| `remote.screenshot` / `remote.stream` | ✅ view capture | ✅ images only | ❌ no video plane | ✅ |
| `remote.input` | ✅ | ✅ | ✅ | ✅ |
| `system.restart_player` | ✅ | ✅ | ❌ widget may not return | ✅ |
| `system.self_update` | ✅ | ❌ | ❌ needs host | ❌ |
| `system.reboot` | ❌ owner-only | ❌ | ❌ needs host | ❌ |
| `sync.clock` | ✅ | ✅ | ✅ | ✅ |
| `offline.cache` | ✅ | ❌ playlist JSON only | ❌ ❓ unverified | ✅ |

Everything conditional at runtime on every platform that has it at all — `system.kiosk`,
`system.brightness`, `system.screen_timeout`, `system.install_apk`, `system.shell`, `system.time`,
`system.device_owner`, `sync.native`, `display.resolution` — is absent from **every** baseline, and
a test enforces that.

## What is tested, and what cannot be

`server/test/player-parity-baselines.test.js` reads the player sources and fails when they and the
claims disagree:

- every baseline and command-map name is in the vocabulary, and no baseline has duplicates;
- **the dead-button rule** — every gated command has a branch in some player;
- **the unreachable-capability rule** — every gating capability is either declared by some player's
  source or granted by some baseline. *This is the test that would have caught the
  `system.device_owner` bug*;
- a device-owner Android panel can actually be sent all five Tier-2 commands, and an ordinary one is
  still refused them **by name**;
- `audio.volume` and `offline.cache` are **biconditional** against the player sources, so a fix in a
  player fails the test until the baseline is updated;
- no baseline claims a conditional capability, and the BrightSign baseline claims nothing behind
  `hasHost()`;
- every capability-shaped string quoted in any player is one the server knows — the server's parser
  *drops* unknown names, so a typo silently removes a control rather than raising anything.

**Not testable from source, and asserted nowhere:** whether CEC reaches a real display; whether a
widget built by our own `autorun.brs` is permitted to register a service worker; whether SyncManager
genuinely holds a wall in frame lock; whether transitions and PiP are visible over a hwz video
plane. Each is marked ❓ above and needs hardware.
