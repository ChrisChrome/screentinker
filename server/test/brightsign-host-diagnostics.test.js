'use strict';

// A BrightSign knows things the page cannot ask for — the uptime, the wired IP, the video mode
// actually in force, which volume it booted from, whether a staged package applied — and all of it
// used to go to a serial console. On a panel on a wall that is the same as reporting nothing.
//
// The cost was concrete: a single bad string literal stopped the host script compiling, and the only
// evidence anywhere in the world was one line on a cable. From the server the display looked
// identical to one that had simply never started. Every other player reports its own failures.
//
// This pins the three-hop contract — host posts, bridge forwards, player emits — because no part of
// it can be executed here. The host half is BrightScript (no interpreter), the bridge half needs a
// widget, and a broken link in the chain is silent by construction: diagnostics that do not arrive
// look exactly like diagnostics that were never generated.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const host = fs.readFileSync(path.join(ROOT, 'brightsign', 'autorun.brs'), 'utf8');
const bridge = fs.readFileSync(path.join(ROOT, 'brightsign', 'st-bridge.js'), 'utf8');
const player = fs.readFileSync(path.join(ROOT, 'server', 'player', 'index.html'), 'utf8');
const code = host.split('\n').filter((l) => !/^\s*'/.test(l)).join('\n');

test('the host reports its boot story, which happens before there is a page to hear it', () => {
  // The interesting failures all live in this window: the storage probe, a pending package being
  // applied, the video mode being set. A design that could only report after the widget existed
  // would miss every one of them.
  assert.match(code, /Sub LogTo\(buf As Object/, 'a buffer the pre-widget phase can log into');
  assert.match(code, /Sub FlushLog\(widget As Object, buf As Object\)/, 'and a flush once there is a page');
  assert.match(code, /boot = CreateObject\("roArray"/, 'Main must create the buffer');
  assert.match(code, /FlushLog\(widget, boot\)/, 'and flush it once the widget exists');
  // The update path is the one that replaces the boot script — its diagnostics are the ones you
  // most want when a player does not come back.
  assert.match(code, /Sub ApplyPendingPackage\(root As String, buf As Object\)/);
  assert.match(code, /LogTo\(buf, "update"/);
});

test('the host reports facts the page has no API for', () => {
  const fn = code.slice(code.indexOf('Sub SendHostTelemetry'));
  for (const [needle, why] of [
    ['UpTime(', 'a display that always reports a small uptime is reboot-looping'],
    ['roNetworkConfiguration', 'the wired IP — there is no JavaScript route to it'],
    ['GetVersion', 'the OS build, which decides which APIs exist at all'],
    ['StorageProbe()', 'the real volume, not the widget cache quota'],
    ['StorageRoot()', 'which volume it booted from'],
    ['PackageVersion()', 'what it is actually running'],
  ]) {
    assert.ok(fn.slice(0, 2000).includes(needle), `host telemetry must include ${needle}: ${why}`);
  }
});

test('a widget rebuild is reported as an incident, not just a console line', () => {
  // The watchdog healing a wedged page is the single most important thing a BrightSign does
  // unattended. Doing it silently made a panel rebuilding itself every two minutes look identical
  // to one that was healthy.
  assert.match(code, /HostEvent\(widget, "crash", "watchdog"/);
  assert.match(code, /HostEvent\(widget, "app_error", "load-error"/);
});

test('the event types the host emits are ones the server actually accepts', () => {
  // The server drops unknown event types silently, so an invented one would be exactly as
  // invisible as the console.warn this replaces.
  const allowed = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'incident-classify.js'), 'utf8');
  for (const m of code.matchAll(/HostEvent\([^,]+,\s*"([a-z_]+)"/g)) {
    assert.ok(allowed.includes(`'${m[1]}'`), `the server does not accept event type "${m[1]}"`);
  }
});

test('the bridge carries logs and events without interpreting them', () => {
  assert.match(bridge, /onHostLog: function/);
  assert.match(bridge, /onHostEvent: function/);
  // Bounded before they reach the wire: the server truncates too, but a host bug should not be
  // able to push a megabyte through the socket every second.
  assert.match(bridge, /msg\.message \|\| ''\)\.slice\(0, 2000\)/);
  assert.match(bridge, /msg\.detail \|\| ''\)\.slice\(0, 500\)/);
});

test('host telemetry merges into the snapshot the heartbeat already sends', () => {
  // Not a new channel — the heartbeat has carried BS.telemetrySnapshot() for releases. The host
  // simply fills in the fields only it can see.
  assert.match(bridge, /msg\.type === 'host-telemetry'/);
  assert.match(bridge, /telemetry\[keys\[i\]\] = v/);
  assert.match(player, /BS\.telemetrySnapshot\(\) : \{\}/);
});

test('the host telemetry listener is registered at load, not behind the readiness gate', () => {
  // The host sends its boot report the moment the widget exists. A listener attached after the
  // bridge finished its own probe would miss precisely the message that says which volume the
  // player came up from and whether a package applied.
  const seg = bridge.slice(bridge.indexOf('var telemetry = {}'), bridge.indexOf('var telemetry = {}') + 1400);
  assert.match(seg, /listeners\.push\(function \(msg\)/);
  assert.ok(!/onReady\(function/.test(seg), 'must not wait on readiness to start listening');
});

test('the player forwards them, and only where the hooks exist', () => {
  assert.match(player, /function wireHostDiagnostics\(\)/);
  assert.match(player, /typeof BS\.onHostLog !== 'function'\) return;/, 'a browser must skip this entirely');
  assert.match(player, /socket\.emit\('device:log'/);
  assert.match(player, /BS\.onHostEvent\(\(ev\) => emitDeviceEvent\(ev\.event, ev\.reason, ev\.detail\)\)/);
});

test('forwarding is wired AFTER the socket, or the boot report is dropped rather than delayed', () => {
  const connect = player.slice(player.indexOf('startVersionCheck();'), player.indexOf('startVersionCheck();') + 400);
  assert.match(connect, /wireHostDiagnostics\(\)/);
});

test('diagnostics can never take the player down', () => {
  // The whole point is a display that keeps playing while telling you it is unhappy. A reporting
  // path that throws would invert that.
  const fn = player.slice(player.indexOf('function wireHostDiagnostics'), player.indexOf('function emitDeviceEvent'));
  assert.equal((fn.match(/try \{/g) || []).length >= 2, true, 'both the wiring and each callback must be guarded');
  assert.match(fn, /catch \(e\) \{ \/\* diagnostics must never break playback/);
});
