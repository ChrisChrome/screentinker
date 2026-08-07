'use strict';

/*
 * The parity matrix keeps drifting away from the players, because a capability list is prose that
 * happens to be executable: nothing breaks when it starts lying. Tizen claimed audio.volume with
 * no set_volume handler anywhere in the shipped player, and the dashboard drew a slider that did
 * nothing. Tizen claimed offline.cache while caching only the PLAYLIST, so a panel survived an
 * outage knowing exactly what it could not show. A real BrightSign advertised offline.cache while
 * its widget refuses to register a service worker at all.
 *
 * None of those were caught by a test, because every test asserted the table against itself.
 *
 * So these tests read the PLAYER SOURCES. They are grep-shaped and that is deliberate: the point is
 * to fail when the code and the claim disagree, not to re-implement the players. Where a claim
 * genuinely cannot be settled from source — CEC actually reaching a display, a widget actually
 * being allowed to register a worker — there is no test here and docs/player-parity.md says so in
 * as many words.
 *
 * Several of these are BICONDITIONAL: they fail both when a baseline over-claims and when a player
 * gains the handler and the baseline was not updated. A test that only fires in one direction is
 * how "too stingy" survives for months after the bug it was working around is fixed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const caps = require('../lib/player-capabilities');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/*
 * Baselines describe what an UN-UPDATED display can do, so they must be judged against the SHIPPED
 * source, not the working tree.
 *
 * This distinction is not pedantic — it is the bug that made this file contradict itself. The
 * baselines were justified against `git show v1.9.28:<source>`, then read from the working tree, so
 * the moment a player's payload bug was fixed the biconditional below demanded a baseline change for
 * displays that cannot possibly have the fix yet. A baseline entry should move when a fix SHIPS, not
 * when it is written.
 *
 * Falls back to the working tree when the tags are not available (a shallow CI clone) — but the
 * BICONDITIONAL tests below then SKIP rather than assert, because that fallback is not a
 * slightly-early assertion, it is an inverted one. It cost a red build to learn: with no tags, CI
 * judged the baselines against a working tree in which a player's payload bug had just been fixed,
 * so the matrix was told to move a baseline for displays that cannot possibly have the fix yet.
 * Green locally, red in CI, for a reason visible nowhere in the diff. A skipped assertion announces
 * itself; a wrong one does not. (ci.yml now checks out with fetch-depth: 0 so this stays a backstop.)
 */
/*
 * "Shipped" means the newest release that is NOT the one being cut. Taking the newest tag outright
 * is wrong at exactly one moment, and it is a moment that happens every time: on the release commit
 * the newest tag IS HEAD, so shipped source becomes the working tree, every biconditional inverts,
 * and the build demands a baseline claim a capability that no fielded display can have until this
 * release reaches it. Found by cutting 1.9.31 — the tag turned a green tree red.
 *
 * A baseline entry moves when the fix reaches displays, which is the release AFTER the one carrying
 * it. So skip any tag pointing at HEAD and judge against its predecessor.
 */
function previousReleaseTag() {
  const head = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  const tags = execSync("git tag --list 'v*' --sort=-v:refname", { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((t) => t.trim()).filter(Boolean);
  for (const t of tags) {
    const at = execSync(`git rev-list -n1 ${t}`, { cwd: ROOT, encoding: 'utf8' }).trim();
    if (at !== head) return t;
  }
  return null;
}

let SHIPPED_TAG = null;
try { SHIPPED_TAG = previousReleaseTag(); } catch (e) { /* no git, or no tags */ }
const shippedFromTag = !!SHIPPED_TAG;

function readShipped(rel) {
  if (SHIPPED_TAG) {
    try {
      return execSync(`git show ${SHIPPED_TAG}:${rel}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
    } catch (e) { /* the path did not exist in that release — fall through */ }
  }
  return read(rel);
}

// A biconditional compares a baseline against the SHIPPED player. Without a tag there is no
// shipped player to compare against, and the working tree is the wrong answer, not a close one.
const needsShippedSource = (t) =>
  shippedFromTag ? false : (t.skip('no release tag available — cannot judge a baseline against shipped source'), true);

const SRC = {
  web: readShipped('server/player/index.html'),
  android: [
    'android/app/src/main/java/com/remotedisplay/player/MainActivity.kt',
    'android/app/src/main/java/com/remotedisplay/player/service/WebSocketService.kt',
    'android/app/src/main/java/com/remotedisplay/player/telemetry/PlayerCapabilities.kt',
  ].map(read).join('\n'),
  tizen: ['tizen/js/app.js', 'tizen/js/device-control.js', 'tizen/js/capabilities.js'].map(readShipped).join('\n'),
  brightsign: ['brightsign/st-bridge.js', 'brightsign/autorun.brs'].map(readShipped).join('\n'),
};

/*
 * Which command names each player has a branch for. A command a player never names is a dead
 * button by construction — the socket delivers it and the handler falls off the end.
 */
function handles(player, command) {
  const src = player === 'brightsign' ? SRC.brightsign + SRC.web : SRC[player];
  // Kotlin `"reboot" ->`, JS `case 'reboot':`, JS `type === 'reboot'`, `data.type === 'reboot'`.
  return new RegExp(`['"]${command}['"]`).test(src);
}

test('every capability name in every baseline exists in the vocabulary', () => {
  // A typo does not fail loudly: supports() returns false for an unknown name, so the control just
  // never appears for that whole platform.
  for (const [family, list] of Object.entries(caps.BASELINE)) {
    for (const c of list) assert.ok(caps.CAP_SET.has(c), `${family} baseline has unknown capability ${c}`);
    assert.equal(new Set(list).size, list.length, `${family} baseline has a duplicate entry`);
  }
});

test('every command in the routing map points at capabilities that exist', () => {
  for (const [cmd, value] of Object.entries(caps.COMMAND_CAPABILITY)) {
    for (const cap of caps.capabilitiesForCommand(cmd)) {
      assert.ok(caps.CAP_SET.has(cap), `${cmd} maps to unknown capability ${cap}`);
    }
    if (Array.isArray(value)) {
      assert.ok(value.length > 1, `${cmd} is a one-element list — write it as a plain string`);
    }
  }
});

test('THE DEAD-BUTTON RULE: every gated command is handled by some player', () => {
  // Not "by every player" — display.power is Android/Tizen/BrightSign and that is correct. But a
  // command NO player names cannot do anything for anyone, and the capability gating it is a lie
  // wherever it is declared.
  const players = ['android', 'web', 'tizen', 'brightsign'];
  for (const cmd of Object.keys(caps.COMMAND_CAPABILITY)) {
    const who = players.filter((p) => handles(p, cmd));
    assert.ok(who.length > 0, `no player has a branch for command '${cmd}' — it is a dead button everywhere`);
  }
});

test('THE UNREACHABLE-CAPABILITY RULE: a gating capability must be reachable', () => {
  /*
   * The bug this catches, found by this audit: all five #161 Tier-2 commands were gated on
   * 'system.device_owner', which no player declares and no baseline grants. supports() therefore
   * returned false for every device in the fleet and the commands were refused universally,
   * including on the device-owner panels they were built for.
   *
   * A capability is reachable if some player's source names it (it can be declared at runtime) or
   * some baseline grants it (an undeclared display gets it). If neither is true, every command
   * behind it is refused for every device, forever, in silence.
   */
  const declaredAnywhere = new Set();
  for (const src of Object.values(SRC)) {
    for (const c of caps.CAPABILITIES) if (src.includes(`'${c}'`) || src.includes(`"${c}"`)) declaredAnywhere.add(c);
  }
  const inSomeBaseline = new Set(Object.values(caps.BASELINE).flat());

  for (const cmd of Object.keys(caps.COMMAND_CAPABILITY)) {
    const needed = caps.capabilitiesForCommand(cmd);
    if (!needed.length) continue;
    const reachable = needed.some((c) => declaredAnywhere.has(c) || inSomeBaseline.has(c));
    assert.ok(reachable, `command '${cmd}' needs ${needed.join(' or ')}, which no player declares and no baseline grants — it is refused for the entire fleet`);
  }
});

test('a device-owner Android panel can actually be sent the Tier-2 commands', () => {
  // The end-to-end shape of the bug above, as the operator meets it: a real owner panel declaring
  // exactly what PlayerCapabilities.kt declares under `if (isOwner)`.
  const owner = {
    client_type: 'apk',
    capabilities: JSON.stringify(['playback.video', 'system.kiosk', 'system.reboot', 'system.time']),
  };
  for (const cmd of ['lock_now', 'power_menu', 'status_bar', 'block_uninstall', 'unblock_uninstall', 'kiosk_lock']) {
    assert.equal(caps.commandAllowed(owner, cmd).ok, true, `${cmd} must reach a device-owner panel`);
  }
});

test('and an ordinary Android panel is still refused them, by name', () => {
  const plain = { client_type: 'apk', capabilities: JSON.stringify(['playback.video', 'remote.input']) };
  const verdict = caps.commandAllowed(plain, 'lock_now');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.capability, 'system.device_owner', 'the refusal names the canonical capability');
});

test('the capture bootstrap is not gated on the capability it creates', () => {
  // enable_system_capture raises the MediaProjection consent dialog. Gating it on remote.screenshot
  // meant the only panel that needs it — no accessibility, no projection grant, therefore no
  // declared remote.screenshot — was the one panel that could not be sent it.
  const noCapture = { client_type: 'apk', capabilities: JSON.stringify(['playback.video']) };
  assert.equal(caps.commandAllowed(noCapture, 'enable_system_capture').ok, true);
});

/* ---- baselines, pinned to the players ------------------------------------------------------- */

test('BICONDITIONAL: audio.volume in a baseline iff that player reads the payload the dashboard sends', (t) => {
  if (needsShippedSource(t)) return;
  /*
   * frontend/js/views/device-detail.js sends set_volume as `{ level: 0..1 }`. Android reads
   * payload.level. The web player reads `payload?.value ?? data.value` and Tizen reads
   * `payload.value ?? payload.volume`, so on both the number is undefined, isFinite fails, and the
   * slider does nothing — a handler that exists and cannot be driven.
   *
   * This fires in BOTH directions on purpose. Fix the one-line payload bug in a player and this
   * test tells you to put the baseline entry back, which is the half everyone forgets.
   */
  const readsLevel = {
    android: /optDouble\("level"/.test(SRC.android),
    web: /set_volume[\s\S]{0,400}?\blevel\b/.test(SRC.web),
    tizen: /applyVolume[\s\S]{0,400}?\blevel\b/.test(SRC.tizen),
  };
  readsLevel.brightsign = readsLevel.web;   // BrightSign runs the web player

  for (const family of ['android', 'web', 'tizen', 'brightsign']) {
    const claimed = caps.BASELINE[family].includes('audio.volume');
    assert.equal(claimed, readsLevel[family],
      claimed
        ? `BASELINE.${family} claims audio.volume but that player never reads payload.level — the slider is dead`
        : `the ${family} player now reads payload.level: restore 'audio.volume' to BASELINE.${family}`);
  }
});

test('audio.mute is real on all four, unlike its neighbour', () => {
  // The contrast that makes the volume result meaningful: mute is driven by device:mute-changed,
  // not by a set_volume payload, and every player has that listener.
  for (const p of ['android', 'web', 'tizen']) {
    assert.ok(handles(p, 'device:mute-changed'), `${p} must handle device:mute-changed`);
  }
  for (const family of Object.keys(caps.BASELINE)) {
    assert.ok(caps.BASELINE[family].includes('audio.mute'), `${family} baseline should keep audio.mute`);
  }
});

test('BICONDITIONAL: offline.cache in a baseline iff that player has a media cache', (t) => {
  if (needsShippedSource(t)) return;
  // Tizen's media cache is a NEW file — it was not in v1.9.28 — so the baseline must not claim it
  // even though HEAD's capabilities.js declares it at runtime. BrightSign's widget is not known to
  // permit a service worker at all.
  const hasMediaCache = {
    android: fs.existsSync(path.join(ROOT, 'android/app/src/main/java/com/remotedisplay/player/data/ContentCache.kt')),
    web: fs.existsSync(path.join(ROOT, 'server/player/sw.js')),
  };
  assert.ok(hasMediaCache.android && hasMediaCache.web, 'the two players that do cache must still have the code');
  assert.ok(caps.BASELINE.android.includes('offline.cache'));
  assert.ok(caps.BASELINE.web.includes('offline.cache'));
  assert.equal(caps.BASELINE.tizen.includes('offline.cache'), false,
    'the fielded .wgt caches the playlist JSON, not the media');
  assert.equal(caps.BASELINE.brightsign.includes('offline.cache'), false,
    'a widget that refuses to register a worker cannot cache one byte');
});

test('display.power is claimed where at least one half does something', () => {
  // Android is the deliberate exception and the baseline comment carries the reasoning: v1.9.28
  // answers screen_on with a logged no-op, but screen_off genuinely blanks the panel (owner/admin
  // FORCE_LOCK, else the accessibility lock). One capability renders both dashboard buttons, so
  // withholding it to hide the dead ON button also removes blank-at-night — the half signage
  // actually schedules — from every panel that has not updated. Kept, knowingly.
  // Tizen implements both with a plain overlay and no signing requirement.
  assert.ok(caps.BASELINE.android.includes('display.power'),
    'screen_off works on a fielded Android panel; do not withhold it to hide screen_on');
  assert.ok(caps.BASELINE.tizen.includes('display.power'));
  assert.equal(caps.BASELINE.web.includes('display.power'), false, 'a browser tab cannot power a panel');
  assert.equal(caps.BASELINE.brightsign.includes('display.power'), false, 'CEC needs the host bridge');

  // And the fielded Tizen player really does implement both halves.
  assert.ok(/showScreenOff/.test(SRC.tizen) && /clearScreenOff/.test(SRC.tizen));
});

test('no baseline claims anything that needs a host bridge or a privilege grant', () => {
  // The one-line version of the whole audit. Each of these is conditional at runtime on every
  // platform that has it at all, so no undeclared display may be assumed to have it.
  const CONDITIONAL = [
    'system.kiosk', 'system.brightness', 'system.screen_timeout', 'system.install_apk',
    'system.shell', 'system.time', 'system.device_owner', 'sync.native', 'display.resolution',
  ];
  for (const [family, list] of Object.entries(caps.BASELINE)) {
    for (const c of CONDITIONAL) {
      assert.equal(list.includes(c), false, `${family} baseline claims the conditional capability ${c}`);
    }
  }
});

test('the BrightSign baseline claims nothing that needs autorun.brs', () => {
  // The bridge's JS half is served by us and is always current, but `port` needs an roHtmlWidget
  // created with nodejs_enabled:true by the on-device BrightScript. No released package shipped
  // both halves, and the one unit on alpha runs BSN Supervisor's widget, where hasHost() is false.
  for (const c of ['system.reboot', 'display.power', 'display.resolution', 'system.self_update', 'system.restart_player']) {
    assert.equal(caps.BASELINE.brightsign.includes(c), false,
      `BASELINE.brightsign claims ${c}, which the web player only declares behind BS.hasHost()`);
  }
  // The web player really does gate all of them on the bridge — if that changes, this reasoning
  // needs revisiting rather than silently going stale.
  assert.ok(/BS && BS\.hasHost\(\)/.test(SRC.web), 'the web player still gates host capabilities on hasHost()');
});

test('the Android baseline claims only what a Tier-0 panel can do', () => {
  // set_volume / set_brightness are #160 Track-A (released v1.9.10) and are applied with no owner,
  // no admin and no WRITE_SETTINGS. Their Tier-1 siblings are not claimed.
  assert.ok(handles('android', 'set_brightness') && handles('android', 'set_volume'));
  assert.ok(caps.BASELINE.android.includes('display.brightness'), 'the per-window dim is Tier 0');
  assert.equal(caps.BASELINE.android.includes('system.brightness'), false, 'the backlight needs WRITE_SETTINGS');
  assert.equal(caps.BASELINE.android.includes('system.reboot'), false, 'STPolicy.reboot() needs device owner');
});

test('capability names are spelled the same in the server and in all four players', () => {
  /*
   * The failure this catches is silent by design: the server's parser DROPS a name it does not
   * recognise, so a typo in a player removes a control rather than raising anything. Any
   * capability-shaped string a player quotes must be one the server knows.
   */
  const SHAPE = /['"]((?:playback|audio|display|remote|system|sync|offline)\.[a-z_]+)['"]/g;
  for (const [player, src] of Object.entries(SRC)) {
    for (const m of src.matchAll(SHAPE)) {
      assert.ok(caps.CAP_SET.has(m[1]),
        `${player} quotes '${m[1]}', which is not in CAPABILITIES — the server would drop it silently`);
    }
  }
});
