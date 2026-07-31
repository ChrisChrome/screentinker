# Changelog

## 1.9.27

**A real pre-release channel: publish a second APK and choose which displays get it.**
1.9.26 added a per-display opt-in, but it was passive — it stopped a sideloaded test build being
reverted, while the build itself still had to be installed by hand on every display. This makes the
opt-in mean something the server can act on.

### Added — beta channel
- **A second APK slot.** Put `ScreenTinker-beta.apk` beside the stable one and it is served only to
  displays with **Accept pre-release builds** ticked. Everyone else continues to get the stable APK,
  unchanged.
- **The beta build must declare its version**, in a sidecar `ScreenTinker-beta.apk.version` holding
  just the version (e.g. `1.9.27-rc1`). This is not optional and it fails closed: a beta with no
  declared version — or an unparseable one — does not activate the channel at all, and opted-in
  displays keep getting stable. The server cannot infer it (stable's version is the server's own
  constant because the two ship together, and reading it from the APK means parsing binary
  `AndroidManifest.xml` on the request path), and advertising a version that does not match the
  bytes served is exactly the condition that produces an update loop.
- **The check and the download resolve the channel identically**, and fall back to stable
  identically, so `apk_size` always describes the bytes actually delivered. An unrecognised channel
  serves stable rather than failing.
- **No player update is required.** The client already fetches whatever `download_url` the server
  hands back, so displays already in the field can be moved between channels from the dashboard.

### Fixed — switching back off a beta
- **Unticking the box now actually moves the display.** Stable is semver-*older* than the beta it
  replaces, so the ordinary "never offer a downgrade" rule stranded the display and unticking would
  have been another silent no-op. It is now offered the release build, reported as `channel-return`.
- The return requires **evidence that the display was actually served the beta channel**
  (`devices.ota_channel_served`, written once when it changes rather than on every check). Returning
  every non-opted-in display that happens to run a pre-release would have dragged existing testers
  back to stable the moment their server upgraded — the precise harm the opt-in exists to prevent.
  A tester who is ahead of the server on a build of their own is left alone, as before.

> **Cut beta builds with the same `versionCode` as the stable release they branch from.** Android
> refuses to install a lower `versionCode`, so a beta numbered above stable can be installed but
> never returned without uninstalling the app — which loses the display's pairing. Equal numbers
> install in both directions, and that is what makes switching back physically possible.

Verified end to end against a live server with two real signed APKs: stable served 1.9.26, beta
served 1.9.27-rc1, an unknown channel fell back to stable, deleting the version file deactivated the
channel mid-run, and the opt-in → serve → switch-back lifecycle produced `offer`, `up-to-date` and
`channel-return` in order.

## 1.9.26

**Android playback fixes for #234, and a way to hand someone a test build without it reverting.**
The YouTube fault below was not specific to the reporter: any playlist containing a YouTube item
stopped rotating at that item, on every Android display, indefinitely.

### Fixed — Android playback
- **A YouTube item now ends on its configured duration.** It never ended at all: images and widgets
  get a timer, ordinary videos end on playback completion, and a YouTube link is played by loading
  an embed into a WebView — which reports no completion, and had no timer armed for it. The item's
  `duration_sec` was passed to the player and never read. The web and Tizen players already timed
  YouTube off its duration; Android was the only player that did not, so this restores parity rather
  than inventing behaviour. Local and remote video are untouched and still end on completion, so
  clips are not cut short.
- **A playlist change is no longer stranded behind an item that never ends.** #157 defers a change
  when the item on screen is dropped from the new list, applying it at the next advance. With a
  YouTube item that advance never came, so assigning a different playlist appeared to be ignored.
  Two guards: an **empty** list is never deferred (clearing a playlist is an operator saying stop,
  not an item rotating out), and a deferral now has a 60-second deadline so no future item type that
  ends on a callback can strand one again.

Verified on an Android 12 emulator against the reporter's exact shape (a 5s image and a long YouTube
video set to 10s): thirteen clean cycles at exactly the configured durations, a playlist swap
applying immediately while the YouTube item was on screen, and a clear stopping playback entirely.

### Fixed — "No playlist" did nothing
- **A display's playlist can now actually be cleared.** The dashboard offered a *No playlist* option
  whose handler discarded the selection (`if (!newPlaylistId) return; // Don't allow deselecting for
  now`) — no request, no change, no error. The guard was honest about why: there was no way to do it.
  `PUT /devices/:id` has never read `playlist_id`, and `POST /playlists/:id/assign` can only set one.
  New `DELETE /api/devices/:id/playlist`, device-scoped because there is no playlist to authorize
  against when clearing, gated by the same ownership check as every other device mutation. Clearing
  an already-clear display is a no-op success, and the empty playlist is pushed to the device so the
  screen stops rather than holding the old content.

### Added — per-display pre-release opt-in
- **"Accept pre-release builds"**, a checkbox beside the existing self-update toggle
  (`devices.ota_beta`, default off). Handing someone a test build was a trap: a prerelease sorts
  *below* its own release (`1.9.25-fix234d` < `1.9.25`), so a sideloaded display asked for updates,
  was correctly told the release was newer, and updated itself straight back off the build it had
  been given — same versionCode, so Android installed it without complaint. Silent, within minutes.
  It cost the #234 reporter an evening of testing code that had already been replaced under them.

  Narrow where it should be: it holds only a prerelease of the core already installed. A plain
  release, a `-patchN` build, an upgrade to a newer core, and a display ahead of the server all
  behave exactly as before, and a fleet that never sets the flag is unaffected. Wide where it must
  be: an opted-in display is exempt from the `superseded-prerelease` guard, which would otherwise
  pin a tester on an old build permanently — opting in must never mean never updating again.

  Note this is an opt-out of being reverted, **not** a second distribution channel: the server still
  serves one APK, so a beta build is still installed by hand.

### Documentation
- The published API reference had drifted to **1.9.0** while 1.9.25 shipped, because
  `bump-version.sh` updated every other version source and not `docs/openapi.yaml`. It now does, and
  a contract test fails if the two diverge.
- A device's two network addresses are documented and told apart — `ip_address` is the public/WAN
  address the server observed on connect, `local_ip` is the display's own LAN address as reported by
  the player — along with the rest of the telemetry block, none of which was in the spec despite
  being returned. `wifi_ssid`'s `"permission"` value is documented as a sentinel, not a network name.
- README catch-up: the public API, why a display might not self-update, what a delete-and-re-pair
  restores (including that a block deliberately survives it), hidden plans, and the optional location
  permission behind the Wi-Fi network name.
- **CHANGELOG backfilled for 1.9.3 through 1.9.25**, which had no entries at all. `bump-version.sh`
  now warns when a release is cut without one.

## 1.9.25

**Android playback and account-admin fixes.** Closes #234 — a playlist that only ever showed its
first item — plus the registration loop feeding it, and three issues found by the same reporter in
an afternoon of testing.

### Fixed — Android playback (#234)
- **A playlist no longer restarts at item one every time the Activity is rebuilt.** `PlaylistController`
  is owned by `MainActivity`, so each rebuild handed it a fresh, empty instance; the playlist then
  arrived, looked like a first load, and playback began from index 0. On a device rebuilding at every
  item boundary the second item held the screen for ~135ms — invisible, which is why it read as "only
  one item plays" rather than "it glitches". Playback position now lives outside the object being
  rebuilt and resumes if the save is recent (cold starts, stale saves and shrunk playlists all still
  begin at item one).
- **A player no longer re-registers itself once per playlist item.** Every advance asked for a
  playlist refresh, and a refresh emits a full `device:register` — so a 10-second image re-registered
  six times a minute, per device, forever, each one running the whole identity path and pushing a
  playlist back down. The heartbeat already refreshes every 60s, so the per-item call was duplicating
  a pull that happens anyway. Measured on the reproduction: 9 registrations for 9 plays → 3.
- **A leaked callback no longer relaunches the app in a loop.** `ProvisioningActivity` left its
  service callbacks attached after pairing, so later events re-entered a finished activity and
  restarted it — a white flash on every cycle, since Android 12+ draws a splash screen on each
  relaunch. Measured: 240 activity starts in 180s → 0.

### Fixed — account administration
- **Unblock now sticks.** Per-device settings are keyed to the hardware and deliberately restore
  `blocked` across a delete + re-pair, so a block cannot be shrugged off by deleting the display.
  Unblock only ever cleared the live copy, so the saved copy put the block straight back on the next
  re-pair and there was no way out from the dashboard. Unblock now clears both; blocking still
  survives a re-pair, which is the property that made this worth getting right.
- **A refused device says why.** A blocked panel sat on "Connecting to server" with nothing surfacing
  the server's rejection.

### Added
- **Every plan is visible to platform admins,** with how many accounts, organizations and displays
  are on each, plus a flag for accounts pointing at a plan that no longer exists. A plan hidden from
  the public pricing page was previously invisible to the operator too.
- **Player permissions can be reviewed and revoked from the setup screen.** Each row stays visible
  once granted and becomes *Manage*, instead of disappearing and leaving no way back.

## 1.9.24

**OTA control for managed panels.** Everything here is about not stranding a display: an operator
override, a retry budget that reflects what a retry actually costs, and a stand-down that only fires
when it should.

### Fixed — OTA
- **Self-OTA now stands down only for a genuine foreign device owner.** The check was broad enough
  that a stock Android panel with no MDM at all logged "self-OTA stands down" and stopped updating.
- **`OTA_ALLOW_MANAGED_DEVICES`** lets an operator override the stand-down when they run an MDM that
  does not distribute the player. Off by default. See the README before enabling — it does not grant
  the ability to install silently.
- **The install retry budget went from 3 attempts to 40, and flagging moved to 3.** Telling an
  operator a panel needs a human and giving up on that panel are separate decisions, and they were
  wired to the same number. A retry is nearly free — the APK is downloaded and signature-checked once
  and reused from cache, so later attempts pull no bytes. Past the budget it settles to about one
  attempt a day, indefinitely; a new version clears the count.
- **"Force update" is now actually forceful, and reports back.** It ignores the back-off, the attempt
  count and the MDM stand-down, and says what happened — including "already up to date", which used
  to return in silence and made a working button look broken.

### Fixed — playback
- **A wipe hands the frame back cleanly at the end,** instead of briefly revealing the outgoing image
  through the transition surface.
- **Turning off follower mode re-arms self-advance,** so a display taken out of a synchronized group
  no longer freezes on whatever was on screen.

## 1.9.23

**Scheduling on a touchscreen, and internationalization.** The weekly calendar becomes directly
manipulable, and a large batch of user-facing strings that were never translated go through `t()`.

### Added
- **The week calendar is directly manipulable** — drag and resize blocks, with grab targets big
  enough for a finger, gestures that work on a touchscreen, pointer handlers bound once rather than
  per render, and a single-day view for when a week will not fit.
- **Schedules that run past midnight draw correctly.**
- **The calendar opens on the working day** and explains what it is for.
- **Empty states tell you what to do next,** based on what the account actually contains.
- **`MAX_FILE_SIZE` is parsed properly** (bytes or a `2GB` / `1500MB` suffix), and the README
  documents the reverse proxy and CDN limits that cap an upload independently — raising the app limit
  alone often changes nothing (#233).
- **An opt-in browser smoke test,** deliberately kept out of `npm test`.

### Fixed
- **Untranslated keys are no longer shipped as user-facing text.**
- **Teams says it is switched off** rather than showing an empty list.
- **Proof-of-play attributes a widget play to the widget that played.**
- **Members is in the nav,** titles reveal on touch, and a stale heartbeat no longer kills a live
  socket.
- **A player re-establishes a socket the server closed.**

## 1.9.22

**Player identity.** Two panels running the same build could collapse into one dashboard row.

### Fixed
- **Each player install gets its own identity.** The web player's fingerprint was derived from
  hardware characteristics alone, so two identical panels produced the same value and merged into a
  single device row. Identity is now per install.
- **A screen-only panel can clear its identity from the URL,** giving a way to split a panel that had
  already merged.
- **Crash reports record where a player crashed,** not only what it said.

## 1.9.21

**Measurement fixes.** Small, all about not lying in the numbers.

### Fixed
- Event-loop lag reports zero for a window with no samples, instead of a stale figure.
- Auth rate-limit rejections are recorded, so they can be measured rather than inferred.
- A device fingerprint is only stored against a device that still exists.

## 1.9.20

**Scheduling across a fleet, and alerting that does not repeat itself.**

### Added
- **Every screen's schedule on one calendar,** rather than one screen at a time.
- **A schedule is stored in the timezone its screen runs in,** so a fleet spanning timezones behaves
  the way an operator means it to.
- **An unpaired player can be recovered without a keyboard** — relevant on signage hardware with a
  remote and no text input.
- **A BrightSign capability probe.**
- Italian translation updated (#232).

### Fixed
- **One alert per outage** instead of one per dedup window.
- Kiosk style values are validated as CSS rather than as HTML.
- A device's OTA rate state is cleared once it proves its identity.

## 1.9.19

### Fixed
- Proof-of-play resolves content references rather than trusting a reported id.
- `sharp` updated to 0.35.x, and the corrupt PNG fixture that update exposed was repaired.

## 1.9.18

### Fixed
- **Device serialization is scoped to what each endpoint actually needs,** rather than returning a
  whole device row everywhere.
- **A solo widget stays mounted** and sizes its keyboard to the viewport.
- Weather-radar example: the map stays centred and bounded, and counts only the warnings on screen.

## 1.9.17

### Added
- **Self-service password reset.**

### Fixed
- **A pairing code expires on device liveness, not row age,** so a slow setup no longer runs out of
  time while the panel is sitting on the code.

## 1.9.16

**Hardening pass.** Findings from an internal auth/authorization review, described here in the same
neutral terms as the commits: this is a public repository and detail that only helps an attacker adds
nothing for an operator deciding whether to upgrade. Upgrade.

### Security / hardening
- Break-glass admin recovery is backed by a revocable, auditable grant.
- Access-gating six-digit codes are generated with a CSPRNG.
- The screenshot route is authorized against the device's workspace.
- Password login is bounded per account, not only per IP.
- The unauthenticated telemetry store is bounded and no longer writes rows.
- `CF-Connecting-IP` is trusted only from a Cloudflare peer, not from any trusted proxy.
- An upload's stored type is derived from file content, and uploads are never served as documents.

### Fixed
- The release tarball keeps `.env.example`, and CI asserts it is there.

## 1.9.15

### Fixed
- **Webpage widgets carry an honest note:** sites that refuse embedding do not work on a device, and
  no client-side signal can reliably tell "blocked" from "loading" (#230).
- The "Reload now" update toast is actually clickable (#229).

### Changed
- Session token resolution centralised across the manual verify sites; the unused `optionalAuth`
  middleware dropped.

## 1.9.14

### Fixed
- **Trial expiry auto-downgrade actually fires** (#228).
- 11 of 13 npm advisories resolved (lockfile only) (#225).

### Added
- Stripe checkout accepts promotion codes (#227).

## 1.9.13

**Content library.** A batch of workflow features for libraries bigger than a handful of files.

### Added
- Multi-file upload (#222), multi-select with batch delete and batch move (#224).
- Server-side search, type filter and sort (#221).
- Subtitle / caption support as a content property (#223).
- **Unstable-connection mode** — caps YouTube at 720p for weak Wi-Fi (#220).
- The Add Display modal shows the server URL, and `/download/apk` links GitHub Releases (#210).

### Fixed
- YouTube ENDED safety net for Shorts and flaky Android TV (#219).
- Visible D-pad focus stroke on the Android setup buttons (#218).
- Uploads respect the current folder (#211).

## 1.9.12

### Added
- **TOTP two-factor authentication** and **email verification on signup**.
- **Proof-of-play on Android and Tizen,** closing the Tizen parity gaps.
- Tizen SSSP install.
- Designer-made widgets can be edited in the designer again, including reconstruction of legacy ones
  (#207).

### Fixed
- Web player cold-start crash from a hoisting error in `renderSeq`.
- The advance timer is reconciled on group/wall mode transitions (#200, #208).
- Weather elements can switch to metric (#206).

## 1.9.11

### Added
- **Transition engine** — GL wipes across the web, Tizen and Android players, including image↔video
  transitions (#204).

### Fixed
- Android supersede wedge and leak, plus a stale-video guard on web and Tizen (#205).

## 1.9.10

**Directory board and widget stability.**

### Added
- Directory board: panel-ring scroll, in-place refresh, per-device frame diagnostic (#203), and
  JSON/CSV import with logo-replaces-title (#195).

### Fixed
- **A zero-duration widget no longer self-loops.** It pegged the Android main thread (#198), and the
  server now floors `duration_sec` so no player can be handed the condition (#199).
- Buffered widget swap and schedule-aware solo-board hold, killing the directory-board black flicker
  (#202); decode-gated image double-buffer does the same for Tizen stills (#193, #187).
- Directory board scroll stutter from a seamless-loop gap mismatch (#197).
- The cross-origin header is set on the route that actually serves content (#196).
- Modals scroll instead of overflowing the viewport (#194).

## 1.9.9

### Fixed
- **Pairing:** closed a deferred-offline reclaim race and made same-code adopt idempotent (#192).

## 1.9.8

### Added
- **Directory-search widget** — interactive search of a directory board, live-synced (#188).
- Dashboard version loading indicator with an immediate first poll (#181).

### Fixed
- YouTube Shorts render 9:16 instead of in a landscape frame (#184, #189).
- A stuck download back-off resets on content change and network reconnect (#170, #190).
- The soft keyboard appears for PIN/URL dialogs over immersive fullscreen (#191).
- Thumbnail images use `data-auth-src` in modals and views (#182), with hydration lazy by default
  (#185).
- Raspberry Pi setup handles both `chromium-browser` and `chromium` package names (#183).

## 1.9.7

### Added
- **SMTP transport** as an alternative to Microsoft Graph for email (#173, #179).

### Fixed
- **A reinstalled panel reclaims its device row** instead of being blocked (#180).

## 1.9.6

### Added
- **Device incident log** — offline cause, network-vs-reboot, display-sleep (#175).
- IndexNow and landing-page optimization (#177); integrations internal linking (#178).

### Fixed
- **Tizen portrait and flipped video via AVPlay hardware-plane rotation** — CSS rotation cannot touch
  the hardware video plane and produced a black screen (#170, #174).
- `/integrations/` is served explicitly so the nav link is not the login page.
- CI uses OS-assigned ephemeral ports for subprocess suites, ending a port-collision flake (#176).

## 1.9.5

**Group sync, device-owner foundation, and agency folders.** The largest release in the 1.9.x line.

### Added
- **Per-group synchronized playback** — every member of a group derives the same (index, position)
  from a server-disciplined clock and a deterministic schedule, so displays start and end each item
  together. Offline-native (no server needed at play time) and split-brain-proof (no leader role).
  Includes snap-on-load, a warm next-clip double buffer, and in-place duration edits (#167).
- **Device-owner tier foundation** — QR provisioning, content expiry, and the tier substrate the
  Tier-2 controls build on (#168).
- **Tier 0/1 system controls with no device-owner dependency** — volume, brightness and screen
  timeout on ordinary panels (#160, #169).
- **Per-token upload folder for agency tokens** — auto-created and subtree-confined (#158, #171).
- **OTA self-update kill switch** — global, per-device, and MDM auto-detect (#166).
- Dashboard version indicator with a GHCR update check (#165).

### Fixed
- **Rotation-aware media** — a portrait photo is upright on both the dashboard and the player
  (#170, #172).
- `bump-version.sh` handles the env-overridable Android version (#168).

## 1.9.4

### Added
- **Hidden settings menu on Android,** opened by a multi-tap BACK/ESC sequence and gated by a PIN;
  the PIN is server-provisioned per device and surfaced on the dashboard, replacing a hardcoded
  `0000` (#152).

### Fixed
- **A player sends its device id and token on reconnect before pairing** (#164).
- Android provisioning and playback robustness.
- Playlist `GET /:id` returns item schedules, so the editor shows them (#156).
- Draft preview runs in a server-side session to bypass CSP (#151).
- Tizen player wedge on a shared `#stage` (same class as #162).

## 1.9.3

**Liveness contract v4 and per-device settings that survive a re-pair.** Follows 1.9.2-patch3.

### Added
- **Exit-signal contract v1** — a player tells the server it is going away, across the server, the
  APK, the `.wgt` and the browser player, so "offline" can distinguish a clean exit from a
  disappearance. Surfaced in the dashboard as an offline annotation with a tooltip, a filter drill-in
  and a list label.
- **Liveness contract v4** — uniform heartbeat acknowledgement, ack-gap tracking, a throttle-aware
  client watchdog, browser lifecycle triggers, and an identity block, implemented across the server,
  the APK, the `.wgt` and the browser player. Includes a three-state dashboard liveness badge.
- **Per-device settings survive delete + re-pair,** keyed to the hardware fingerprint: a re-paired
  panel comes back with its name, orientation, timezone, notes and playlist already set (#150).

### Fixed
- **Legacy `-patchN` builds are treated as released versions,** so the existing fleet is offered
  updates.
- Tizen: watchdog config-proofing, teardown hygiene, dead-screen self-heal, offline snapshot,
  keep-awake re-assert and a suspend/resume handler.
- Dashboard: `device-detail.js` parse and runtime errors that took out the whole view; liveness badge
  filter regression; list-view legibility.
- CSP allows the Cloudflare Web Analytics beacon to load *and* report.

## 1.9.2-patch2

**Server/CMS-only field-safe net for #148 — NO Android APK, players unchanged.** Makes the
server absorb a device that opens duplicate/rapid sockets, so a thrashing PAIRED device
converges to ONE stable connection and stays online. It does **NOT** fix the client opening
duplicate sockets (the APK duplicate-socket root cause — separate track); **#148 is not closed
on this alone.**

### Fixed / hardened — eviction storm (#148)
- **Per-device session-settle debounce.** When a device_id with a LIVE incumbent socket opens
  another socket within a short window (`SESSION_SETTLE_WINDOW_MS`, default 2500ms), the
  duplicate is **soft-refused and the incumbent kept** — so a duplicate burst converges on one
  connection and the device stays online, instead of churning through evictions. This closes
  the gap the reconnect-throttle's **30s post-restart warm-up** leaves open (during warm-up only
  the hard ceiling applies, so a burst passed undamped and each new socket evicted the prior).
  The debounce is **warm-up-independent**.
- **Liveness safeguard:** the incumbent is only kept if its socket is genuinely live; a
  dead/half-open incumbent is replaced — the device is **never stranded offline**.
- **Soft refusal, never a quarantine** (paired-safe); single-session enforcement intact for a
  legitimate move; unpaired/abusive flapping still caught by the existing limiters.

Operational note: a chunk of the observed churn was the warm-up window **re-opening on every
rapid patch redeploy** — the debounce closes that in code, but reducing redeploy frequency
independently reduces warm-up-window exposure.

Server/CMS only; ships no APK (versionCode still increments so a future player build is
OTA-recognized). Docker: `ghcr.io/screentinker/screentinker:1.9.2-patch2` (pre-release —
`:latest` stays at 1.9.2).

## 1.9.2-patch1

**Server/CMS-only connection-lifecycle hardening for #148 — NO Android APK, players stay on
their current builds.** This strictly HELPS and de-risks, but is **NOT a guaranteed #148 fix**:
the MAXHUB client-side reconnect failure and the disconnect synchronizer (edge conntrack /
reporting) are separate, unproven-here tracks that may still require a client update / a Bold
Sophos-edge review — **do not consider #148 fully closed on this patch alone.**

### Fixed / hardened — connection lifecycle (#148)
- **The flap-limiter no longer quarantines legitimate PAIRED devices on reconnect churn.** A
  paired + authenticated device reconnecting is exempt from the 30-min quarantine escalation
  (a brief soft cooldown at most), so a repeated edge/NAT flush behind one SNAT IP can no
  longer be amplified into a self-inflicted fleet-wide lockout. Unpaired/abusive flapping is
  still quarantined (the attacker / unprovisioned-hammering case is unchanged).
- **Marking a device offline now also closes its socket**, so DB-offline can't diverge from
  socket-state into a silent half-open the client is never told about.
- **Faster half-open detection:** ping interval 30s → 15s (the pong TIMEOUT is kept at 30s so
  decode-loaded TV WebKits aren't falsely dropped) → dead-peer detection 60s → 45s on BOTH the
  server AND the client (the client inherits these via the handshake — **no APK needed**).
- **TCP SO_KEEPALIVE** on every connection so a half-open TCP can't persist indefinitely at the
  OS layer.

Server/CMS version only; ships no APK (versionCode still increments so a future player build is
OTA-recognized). Docker: `ghcr.io/screentinker/screentinker:1.9.2-patch1` (pre-release —
`:latest` stays at 1.9.2).

## 1.9.2

**⚠ Major internal hardening release (the "#146" rewrite) — large blast radius.** 1.9.2
rewrites the connection / maintenance / OTA hot paths to kill an event-loop death spiral,
plus adds usage-metering (billing) and web-player fixes. If you bisect a regression to the
1.9.x line, 1.9.2 is the big one. Core invariant introduced: **no synchronous op may block
the event loop for more than ~50ms**, ever. Every new subsystem has an env kill-switch.

### Fixed — maintenance / prune (the death-spiral root cause)
- **Non-blocking, chunked, per-device `device_status_log` prune.** The old whole-table
  `ROW_NUMBER` sort froze boot for 40–48s at ~1M rows → healthcheck fail → restart loop that
  wiped in-memory throttle state → the spiral. Prune is now per-device, indexed, batched with
  `setImmediate` yields (`lib/chunked-prune.js`), async, re-entrant, and band-gated on the
  interval run (the startup prune is intentionally un-gated so a bloated table self-heals on
  first boot without freezing it). All table-growth sweeps (status-log, play-logs,
  provisioning, telemetry, lag) route through the chunked helper. New index
  `idx_devices_provisioning`. **Measured worst-case event-loop gap under the storm harness:
  <300ms across 300k rows (was 40–48s).**

### Fixed — reconnect / flap
- **Per-device flap-rate limiter** (`lib/flap-limiter.js`): a device reconnecting faster than
  `CONNECT_RATE_MAX` (20) per `CONNECT_RATE_WINDOW_MS` (5min) is refused at the register gate,
  keyed via a **SNAT-safe identity chain** (device_id → fingerprint → token → one bounded
  global anon bucket) — **never by IP** (the whole fleet egresses one IP). After repeated
  trips a hard flapper is **quarantined IN-MEMORY for 30min and auto-clears** — it is NOT a
  durable DB block.
- **Operator block kill-switch:** `POST /api/devices/:id/{block,unblock}` + a dashboard
  button; the block check resolves the effective device_id via the identity chain so a
  device_id-less reconnect of a blocked device is still caught. Takes effect on next register,
  no restart.
- Also folded in: false-offline fixes (live-socket liveness beats a lagged heartbeat clock;
  evicted-socket re-arm race) and per-connection fail-fast so one device's handler throw can
  never exit the process.

### Fixed — OTA (SNAT-safe)
- `/api/update/check` early-returns before any filesystem call when there's no offer; APK
  metadata is cached. `/download/apk` gains a **band-aware** global concurrency + rate guard
  that sheds with **503 Retry-After only under elevated/critical loop-lag** — under normal
  band, downloads serve freely (a coordinated fleet rollout is never staggered when healthy).
  All limiting is global/aggregate — **no per-IP limiting** (SNAT).

### Added — telemetry / logging / observability
- Batched `event_loop_lag` inserts (buffered, flushed every 10s) and coalesced high-frequency
  logging (one summarized line per key per 30s; band *changes* stay immediate).
- **Throughput counters** (running total + last-completed-window) in the `/api/status` debug
  block so a flapper/flood shows on the server itself (`flap.refusedLastWindow` climbing while
  `band=normal` = the limiter absorbing it cheaply). The debug block is now **admin-toggleable**
  (Admin tab, persisted, no restart; default follows `STATUS_DEBUG_ENABLED`).
- **`devices_connected`** on `/api/status` (always-on): the live WS-socket count from the
  heartbeat connection map (NOT the lagging `devices.status='online'` column).

### Added — billing (usage metering)
- **Billable Screens** metering per the ByteTinker–Bold agreement — the contractual
  system-of-record. A durable daily rollup (`device_usage_daily`) is accumulated incrementally
  off the heartbeat tick from live presence (retention-independent), pruned chunked. Exposed on
  a **dedicated, admin-gated `GET /api/billing/usage`** route (NOT on `/api/status`; billing is
  revenue data). Readable via an **owner-minted, revocable `billing:read` scoped token**
  (`scripts/mint-billing-token.js`) that authorizes billing-read and nothing else, OR a
  platform-admin session. See [`docs/billing.md`](docs/billing.md).

### Fixed — web player
- **"Unchanged" refresh no longer drops the video.** On a reconnect the server re-emits
  `device:paired` while content is already playing; the player showed the idle "Waiting for
  content…" overlay unconditionally (covering live video; audio kept playing underneath) and
  the following "Playlist unchanged" left it up. Idle now shows only when genuinely idle, and
  an unchanged refresh is a strict no-op that leaves playback exactly as-is.
- Hardened `PlayerMediaHealth` call sites to guard by **method** (not object) so a stale-cached
  player module can't throw `shouldShowIdle is not a function` and abort a socket handler.

### Added — translations
- Italian (`it`) locale updated (#145).


## 1.9.2-beta1 — unreleased

### Fixed — server resilience (#142)
- **A single flapping device can no longer saturate the event loop.** A new
  load-aware, per-device reconnect throttle (`lib/reconnect-throttle.js`) gates
  genuine reconnects *before* the heavy register work (DB writes + playlist build).
  The verdict is per-device; global event-loop lag only multiplies an
  already-flagged device's backoff and never throttles a healthy one. Hard ceiling
  + cold-start warm-up so a full-fleet reconnect after a deploy is never throttled.
- **`device_status_log` growth is bounded.** Added
  `idx_device_status_log_device_ts`, a global retention sweep (`pruneStatusLog`,
  `STATUS_LOG_RETENTION_DAYS` default 3) covering removed/idle devices and the
  `offline_timeout` path, and de-duplicated the table's `CREATE TABLE`.
- **`content-ack` spam de-duplicated.** Repeated identical
  `(device_id, content_id, status)` reports are suppressed within
  `CONTENT_ACK_DEDUP_MS` (default 10s).
- **Provisioning cleanup window corrected.** Unclaimed provisioning devices are now
  swept after 24h (the code used `365 * 86400` — a year — contradicting its own
  comment).

### Added — observability (#142)
- **Event-loop lag telemetry** via `perf_hooks.monitorEventLoopDelay()`. Sampled to
  a bounded `event_loop_lag` table (indexed + pruned, `LAG_TELEMETRY_RETENTION_DAYS`)
  and surfaced on `/api/status` as `loop_lag` (mean/p50/p99/max + band).

### Maintenance
- Operators whose `device_status_log` is already bloated from a pre-1.9.2 deployment
  should reclaim disk with a **one-time manual `VACUUM`** in a maintenance window;
  retention now bounds further growth. Auto-VACUUM is intentionally not enabled.
  See [`docs/maintenance-device-status-log.md`](docs/maintenance-device-status-log.md).

## 1.9.1-beta3 — unreleased

### Fixed — Tizen player
- **#118 Sticky "Not authenticated" banner.** On TV sleep/wake the socket reconnects and
  a heartbeat could fire on the fresh, not-yet-registered socket; the server rejected it
  with `device:auth-error`, which the player showed as a *sticky* toast over still-playing
  content (and, worse, dropped its saved credentials and re-paired). Heartbeats are now
  gated on a per-connection `authenticated` flag (set only between `device:registered` and
  `disconnect`/`auth-error`), the heartbeat timer is stopped on `connect`/`disconnect`/
  `auth-error`, the stale banner is cleared on `device:registered`, and the `auth-error`
  toast is non-sticky so any transient case self-clears.
- **#119 `app_version` stuck at `1.0.0`.** The hardcoded constant made every Tizen device
  report `1.0.0` regardless of the installed `.wgt`. The version now resolves at runtime
  from `config.xml` via the Tizen application API, with a fallback constant that
  `build-wgt.sh` stamps from `config.xml`'s `version=""`.

### Added — Tizen player
- **Video walls (`wall:sync`).** The Tizen player now supports wall membership: when the
  payload carries `wall_config`, a new `WallController` positions the stage (vw/vh) as this
  screen's slice of the wall and drives the single-zone player as leader or follower. The
  leader broadcasts `wall:sync` at 4Hz; followers align their index and keep their video
  locked to the leader's clock with a latency-compensated drift controller (hard-seek past
  0.3s, gentle ±3% playbackRate nudge past 0.05s), and request an immediate position on
  (re)connect via `wall:sync-request`. Mirrors the web player (the Android player has no
  wall support). Per-tile `rotation` is not applied yet (web-player parity). Wall emits are
  gated on auth + connection so a pre-register tick can't trip `device:auth-error`.
- **Multi-zone layouts (Android parity).** The Tizen player now renders assigned layouts,
  not just fullscreen single-zone. A new `ZoneRenderer` (ports the Android `ZoneManager`)
  positions zones by percent geometry with `z_index`/`fit_mode`/background, groups
  assignments by `zone_id` (unassigned content goes to the first zone), and rotates each
  zone independently with the same per-item schedule gating (#74/#75). `app.js` selects the
  renderer from `payload.layout`; single-zone playback is unchanged. (Video walls
  `wall:sync` are still Android-only.)
- **#121 Remote commands.** Added a `device:command` handler (`refresh`, `launch`,
  `screen_on`, `screen_off`, plus honest no-op toasts for `update`/`reboot`/`shutdown`,
  which need B2B/MDM privileges a sideloaded app lacks). Removed the dead `device:reload`
  listener (the server never emitted it) in favour of `device:command` `refresh`.
- **#120 Dashboard preview.** Added `device:screenshot-request` / `device:remote-start` /
  `device:remote-stop`. Images capture for real; `<video>`/YouTube fall back to a status
  card because the TV's hardware video plane and cross-origin iframes can't be read into a
  `<canvas>`. See `tizen/README.md` for the support matrix.
- **#122 Updates / boot.** Documented the supported paths — `.wgt` re-sideload or URL
  Launcher/MDM refresh for updates, and display-level kiosk/URL-Launcher settings for
  auto-launch on boot (there is no in-app OTA or `config.xml` autostart for a sideloaded
  consumer TV web app).

## 1.9.0 — 2026-06-11

### Added
- **Per-playlist-item schedules.** Each playlist item can carry one or more schedule
  blocks — active days, a start/end time-of-day, and optional start/end dates. An item
  plays when the screen's local "now" matches at least one block; an item with no
  blocks always plays. Edit per item via the clock icon in the playlist editor (a badge
  summarises the schedule on each row).
  - **#74 dayparting:** time-of-day + day-of-week windows, including overnight windows
    that cross midnight (a Fri 22:00–02:00 block is active Sat 01:00).
  - **#75 auto-expire:** inclusive start/end dates; an item past its end date stops
    showing automatically — even on offline screens, because evaluation is on-device.
- All three players (web, Android, Tizen) evaluate schedules client-side against their
  own clock, so dayparting and expiry work offline. They share one evaluator contract,
  `shared/schedule-vectors.json` — 39 conformance vectors covering DST (US + AU),
  overnight-wrap day anchoring, timezone correctness, and date boundaries. CI runs the
  vectors against the JS evaluator (node) and the Kotlin port (Gradle/JUnit); the Tizen
  copy is byte-identical to the JS source and checked under node.
- Device detail now shows the screen's reported timezone and clock, with a **clock-skew
  warning** when the device clock differs from the server by more than 2 minutes (a bad
  device clock makes schedules fire at the wrong local time).

### Changed — device-level schedule timezone (behaviour change)
- Device/group **schedule overrides** (the existing calendar feature) are now evaluated
  in each device's effective timezone instead of the server's local time. Previously the
  `schedules.timezone` field was never applied and "07:00" meant the *server's* 07:00.
  Now "07:00" means the *screen's* 07:00 — which is what was intended.
  - **Who is affected:** self-hosters whose server timezone differs from their screens'
    timezone — their existing device schedules will shift to fire at the screens' local
    time. Single-timezone deployments (server and screens in the same zone) are
    unaffected. A device with no timezone set and not reporting one falls back to the
    server clock (unchanged from before).

### Fixed
- **#81 — release APK is now v1 + v2 + v3 signed.** With `minSdk 26`, the Android Gradle
  Plugin defaulted the v1 (JAR) signature *off*, producing a v2-only APK that some
  MDM-managed commercial signage (e.g. MAXHUB via the Pivot MDM) silently removes on the
  next reboot — so screens that power-cycle nightly lost the app and fell back to the
  setup screen. Setting `enableV1Signing = true` had no effect at minSdk ≥ 24; the release
  build now re-signs with `apksigner` and a low `--min-sdk-version` to emit the JAR
  signature alongside v2/v3. Verified to install and run on Android 14+/API 36 as well.

### Notes
- **Scheduling fails open.** If the on-device evaluator ever errors (bad timezone id,
  malformed block), the item **plays** rather than being hidden. A blank screen is worse
  than an over-running promo — this is a guarantee, enforced in all three players.
- Windows are enforced at **item boundaries**: a long item finishes before the schedule
  is re-checked, so it can overshoot its window by up to its own duration.
- **A single video *with a schedule* now re-renders at each loop boundary** so its window
  can be re-evaluated; seamless native looping still applies to unscheduled single videos.
  Deliberate tradeoff — a brief seam each loop for a scheduled lone video, in exchange for
  its daypart/expiry actually being honoured.
- **Re-publish required:** editing a schedule puts the playlist into draft; publish to
  push schedules to devices. Existing published playlists keep playing unchanged until
  re-published.
- Players that predate this release ignore the new fields and keep playing everything
  (graceful degradation) — update players to honour schedules.
