# ScreenTinker on BrightSign — capability probe

Not a port. This answers, on **real hardware**, the questions that decide what a port looks like —
so the design isn't guessed from documentation.

## Run it

1. FAT32-format an SD card. It must be **empty** — a card with leftover data won't trigger a fresh
   provisioning cycle.
2. Copy `autorun.brs` and `probe.html` to the **root**.
3. Insert with the player powered off, then power on.
4. Read the screen. Remote devtools are on `http://<player-ip>:2999` if you'd rather read it there.
5. **Power-cycle and reload.** The reboot markers are the point — first run writes them, second run
   says which survived.

## What it answers, and why each matters

| check | why it decides something |
|---|---|
| which `@brightsign/*` modules resolve | `nodejs_enabled: true` injects them into the runtime. If injection is origin-independent, a **remotely-served** page gets them too — which is the whole cheap path. |
| `registry` survives reboot | ScreenTinker's device identity (`deviceId`, `deviceToken`, `paired`, `serverUrl`) lives in `localStorage`, and on BrightSign that behaves like sessionStorage. Without a durable store every panel re-pairs on every boot and spawns a new device row. |
| `localStorage` survives reboot | If it does on this OS build, the port gets dramatically simpler. Reports say it doesn't; worth confirming rather than inheriting a 2019 answer. |
| serviceWorker / Cache API / indexedDB | The web player registers `/player/sw.js` for content caching. If unavailable, offline playback has to move to BrightSign's storage APIs — which is the "extra mile" work anyway. |
| `<video>` + h264 | Whether HTML5 video is viable as a stopgap before wiring the native decode path. |
| CSS `clamp()` | The directory-search keyboard scales with `clamp(…vh…)`. Chromium 87 (Series 4) is the risk. |
| reach `screentinker.com/api/status` | Rules network/TLS out before blaming anything else. |

## Then: the actual question

The probe runs **locally** first to establish the baseline. Once `registry` resolves from
`file:///`, change `url:` in `autorun.brs` to a hosted copy of `probe.html` and re-run.

- **Still resolves →** point the widget at the hosted player, swap identity persistence to the
  registry, done. Days, not weeks.
- **Doesn't resolve →** a local shim page owns the registry and passes identity to the hosted
  player in an iframe via `postMessage`. The Chromium 110/120 notes say iframes now *require*
  `postMessage()` for BrightSign objects, which suggests this is the sanctioned pattern rather
  than a workaround.

## Model notes

Target **Series 6** (ships Chromium 120) or **Series 5** (upgradeable via the `html/widget_type`
registry key). **Series 4 is pinned to Chromium 87** — a result from one would be misleadingly
pessimistic.

## Scope

A URL wrapper is the on-ramp, not the destination. Doing this properly on BrightSign means the
registry for identity, SD for offline media, and their native video path rather than `<video>`.
ScreenTinker's existing multi-zone layouts, video walls and group sync map onto that platform's
strengths unusually well — those are the parts worth showing off.
