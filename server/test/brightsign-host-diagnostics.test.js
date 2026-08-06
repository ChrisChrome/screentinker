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

// Objects built inside the vm carry the vm realm's prototypes, so deepStrictEqual would compare
// realms rather than values. Round-trip through JSON to compare what actually crossed the bridge.
const norm = (x) => JSON.parse(JSON.stringify(x));

/*
 * The bridge half, actually EXECUTED against a fake widget rather than pattern-matched.
 *
 * The two source-regex assertions this replaces both passed while the chain was broken end to end,
 * which is the whole argument for running it: "the file contains onHostLog" is not evidence that a
 * log line reaches anybody. `deliver` plays the part of roHtmlWidget.PostJSMessage.
 */
function loadBridge() {
  const vm = require('node:vm');
  const inbound = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    navigator: { userAgent: 'BrightSign/9.0.189 (XT245) Chrome/120' },
    location: { search: '' },
    setTimeout: () => 1, setInterval: () => 1, clearTimeout: () => {},
    Promise, Object, Array, Uint8Array, Math, Date, RegExp, String, Number,
    parseInt, isNaN, isFinite, decodeURIComponent, Error,
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.window = sandbox;
  sandbox.require = (name) => {
    if (name === '@brightsign/messageport') {
      return function () {
        return {
          PostBSMessage: () => {},
          addEventListener: (evt, fn) => { if (evt === 'bsmessage') inbound.push(fn); },
        };
      };
    }
    throw new Error('no module ' + name);
  };
  vm.createContext(sandbox);
  vm.runInContext(bridge, sandbox);
  return { api: sandbox.ScreenTinkerBS, deliver: (msg) => inbound.forEach((fn) => fn(msg)) };
}

test('the host reports its boot story, which happens before there is a page to hear it', () => {
  // The interesting failures all live in this window: the storage probe, a pending package being
  // applied, the video mode being set. A design that could only report after the widget existed
  // would miss every one of them.
  assert.match(code, /Sub LogTo\(buf As Object/, 'a buffer the pre-widget phase can log into');
  assert.match(code, /Sub FlushLog\(widget As Object, buf As Object\)/, 'and a flush once there is a page');
  assert.match(code, /boot = CreateObject\("roArray"/, 'Main must create the buffer');
  assert.match(code, /FlushLog\(widget, boot\)/, 'and flush it once a page is listening');
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
  const { api, deliver } = loadBridge();
  const logs = [];
  const events = [];
  api.onHostLog((l) => logs.push(l));
  api.onHostEvent((e) => events.push(e));

  deliver({ type: 'host-log', tag: 'update', level: 'i', message: 'package applied' });
  deliver({ type: 'host-event', event: 'crash', reason: 'watchdog', detail: 'no heartbeat for 120s' });

  assert.deepEqual(norm(logs), [{ tag: 'update', level: 'i', message: 'package applied' }]);
  assert.deepEqual(norm(events), [{ event: 'crash', reason: 'watchdog', detail: 'no heartbeat for 120s' }]);

  // Bounded before they reach the wire: the server truncates too, but a host bug should not be
  // able to push a megabyte through the socket every second.
  deliver({ type: 'host-log', tag: 'x'.repeat(200), message: 'y'.repeat(5000) });
  deliver({ type: 'host-event', event: 'app_error', reason: 'r'.repeat(200), detail: 'd'.repeat(5000) });
  assert.equal(logs[1].message.length, 2000);
  assert.equal(logs[1].tag.length, 64);
  assert.equal(events[1].detail.length, 500);
  assert.equal(events[1].reason.length, 64);
});

test('THE DROPPED BOOT REPORT: a diagnostic sent before anyone subscribed is still delivered', () => {
  // The regression this whole file exists to prevent, and it was live. The ordering is not an edge
  // case, it is the ONLY ordering: the host buffers its pre-widget lines and posts them the instant
  // the page says hello, while the player deliberately does not subscribe until its socket is up
  // (forwarding earlier would have nowhere to send them). Between those two correct decisions every
  // boot line fell on the floor — the host spoke to a page with no listener, and the listener
  // arrived after the words had gone.
  //
  // So the bridge holds them. Nothing else in the chain can: the host has already moved on and the
  // player cannot subscribe any earlier.
  const { api, deliver } = loadBridge();
  deliver({ type: 'host-log', tag: 'boot', level: 'i', message: 'host 1.2.3 from SSD: -> https://s' });
  deliver({ type: 'host-log', tag: 'update', level: 'i', message: 'package applied — rebooting into it' });
  deliver({ type: 'host-event', event: 'app_error', reason: 'load-error', detail: 'attempt 1: https://s/player' });

  const logs = [];
  const events = [];
  api.onHostLog((l) => logs.push(l));
  api.onHostEvent((e) => events.push(e));

  assert.deepEqual(logs.map((l) => l.tag), ['boot', 'update'], 'the boot story must survive the gap');
  assert.deepEqual(events.map((e) => e.event), ['app_error']);

  // ...and delivery keeps working normally afterwards, oldest-first with no duplication.
  deliver({ type: 'host-log', tag: 'tel', level: 'i', message: 'later' });
  assert.deepEqual(logs.map((l) => l.tag), ['boot', 'update', 'tel']);
});

test('a second subscriber gets the same history, and one that throws cannot eat it', () => {
  const { api, deliver } = loadBridge();
  deliver({ type: 'host-log', tag: 'boot', level: 'i', message: 'early' });

  api.onHostLog(() => { throw new Error('a consumer blew up'); });
  const logs = [];
  api.onHostLog((l) => logs.push(l));
  assert.deepEqual(logs.map((l) => l.message), ['early'], 'a broken consumer must not swallow the replay');
});

test('the pending queue is bounded — a reboot loop must not grow it without limit', () => {
  // This player runs for months. An unbounded buffer fed by a host stuck in a loop is a slow leak
  // on the one device nobody is watching.
  const { api, deliver } = loadBridge();
  for (let i = 0; i < 5000; i++) deliver({ type: 'host-log', tag: 'boot', message: 'line ' + i });
  const logs = [];
  api.onHostLog((l) => logs.push(l));
  assert.ok(logs.length > 0 && logs.length <= 200, `queue must be capped, got ${logs.length}`);
});

test('host telemetry merges into the snapshot the heartbeat already sends', () => {
  // Not a new channel — the heartbeat has carried BS.telemetrySnapshot() for releases. The host
  // simply fills in the fields only it can see.
  assert.match(bridge, /msg\.type === 'host-telemetry'/);
  assert.match(bridge, /telemetry\[keys\[i\]\] = v/);
  assert.match(player, /BS\.telemetrySnapshot\(\) : \{\}/);
});

test('the host telemetry listener is registered at load, not behind the readiness gate', () => {
  // The host sends its boot report the moment the page says hello. A listener attached after the
  // bridge finished its own probe would miss precisely the message that says which volume the
  // player came up from and whether a package applied.
  //
  // Executed, not pattern-matched: the previous form asserted that a `listeners.push` appeared
  // within 1400 characters of a variable declaration, which is a statement about formatting.
  const { api, deliver } = loadBridge();
  deliver({ type: 'host-telemetry', boot_volume: 'SSD:', storage_free_mb: 90000, package_version: '1.2.3' });
  assert.deepEqual(norm(api.telemetrySnapshot()), {
    boot_volume: 'SSD:', storage_free_mb: 90000, package_version: '1.2.3',
  });
});

test('the host holds its boot log until a PAGE answers, not until a widget exists', () => {
  // Show() only creates the widget: the page has not been fetched, let alone run st-bridge.js, so a
  // flush there posts into a void. The `probe` message is the first proof that JavaScript is running
  // on the other end, and is therefore the earliest moment the buffer can actually be delivered.
  const main = code.slice(code.indexOf('Sub Main()'));
  const afterShow = main.slice(main.indexOf('widget.Show()'), main.indexOf('widget.Show()') + 400);
  assert.ok(!/FlushLog\(/.test(afterShow),
    'flushing straight after Show() posts the boot story to a page that has not loaded yet');

  const probeBranch = main.slice(main.indexOf('m.type = "probe"'), main.indexOf('m.type = "probe"') + 400);
  assert.match(probeBranch, /FlushLog\(widget, boot\)/, 'flush when the page proves it is listening');
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
