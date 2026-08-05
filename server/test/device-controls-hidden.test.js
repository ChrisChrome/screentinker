'use strict';

// The dashboard offered every control to every display. "Reboot device" on a browser tab, screen
// power on a Tizen TV, a Remote tab whose live view is a permanently black canvas on a player with
// no framebuffer read. Every one of them looked like a working button and did nothing — the
// "reports success and changes nothing" shape that keeps costing people days.
//
// Controls are now HIDDEN, not disabled: a greyed-out button on a panel that will never gain the
// capability is a permanent unanswerable question. Which makes the opposite failure the dangerous
// one — a gate that is slightly too strict strips controls from the several hundred displays
// already in the field, none of which declare anything. That case gets its own test below, and it
// is the one to read first if this file ever goes red.
//
// This renders the real device-detail template out of the source file rather than asserting on a
// copy of it, so a control added later without a gate shows up here instead of in production.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');

// The template is one tagged region inside loadDevice(). Pull it out and evaluate it against
// stubbed helpers — the point is which controls appear, not how they are styled.
const START = 'contentEl.innerHTML = `';
const template = (() => {
  const i = SRC.indexOf(START);
  assert.ok(i > 0, 'device-detail.js no longer has the innerHTML template this test renders');
  const j = SRC.indexOf('\n    `;', i);
  assert.ok(j > i, 'could not find the end of the template');
  return SRC.slice(i + START.length, j);
})();

function render(device) {
  const caps = Array.isArray(device.capabilities) ? device.capabilities : null;
  const sandbox = {
    device,
    caps,
    can: (cap) => (caps ? caps.includes(cap) : true),
    latestTelemetry: {},
    diagWidget: null,
    // Stubs. Each returns something recognisable so a control cannot be "found" by accident.
    t: (key) => key,
    esc: (s) => String(s == null ? '' : s),
    formatBytes: () => '0 MB',
    formatUptime: () => '0m',
    ssidLabel: () => 'ssid',
    livenessBadge: () => ({ state: 'online', label: 'online', title: '' }),
    renderDiagPanel: () => '',
    renderDeviceClock: () => '',
    renderPlaylist: () => '',
    isBrightSignDevice: (d) => String(d.platform || '').toLowerCase().includes('brightsign'),
    TERMINAL_PRESETS: [],
    localStorage: { getItem: () => null, setItem: () => {} },
    Math, Date, JSON, String, Array, Object,
  };
  return vm.runInNewContext('`' + template + '`', sandbox);
}

const ANDROID_FULL = {
  client_type: 'apk', android_version: '13',
  capabilities: ['playback.video', 'audio.volume', 'display.power', 'display.brightness',
    'remote.screenshot', 'remote.stream', 'remote.input',
    'system.reboot', 'system.restart_player', 'system.self_update'],
};
const WEB = {
  android_version: 'Web/Chrome',
  capabilities: ['playback.video', 'audio.volume', 'remote.screenshot', 'remote.stream',
    'remote.input', 'system.restart_player'],
};
const TIZEN = {
  platform: 'Tizen 6.5',
  capabilities: ['playback.video', 'audio.volume', 'display.rotation', 'remote.input',
    'system.restart_player'],
};
const BRIGHTSIGN = {
  platform: 'brightsign', hardware_model: 'XT245',
  capabilities: ['playback.video', 'audio.volume', 'display.power', 'display.rotation',
    'remote.input', 'system.reboot', 'system.restart_player'],
};

const has = (html, id) => html.includes(`id="${id}"`);

test('a browser tab is no longer offered controls over a machine it cannot touch', () => {
  const html = render(WEB);
  assert.equal(has(html, 'rebootBtn'), false, 'a tab cannot reboot the PC it is running on');
  assert.equal(has(html, 'shutdownBtn'), false);
  assert.equal(has(html, 'screenOffBtn'), false, 'nor switch off the monitor');
  assert.equal(has(html, 'screenOnBtn'), false);
  assert.equal(has(html, 'forceUpdateBtn'), false, 'nor update itself — the page reloads instead');
  assert.ok(has(html, 'launchAppBtn'), 'but reloading the player IS something it can do');
});

test('a Tizen TV is not offered screen power or the reboot it has no API for', () => {
  const html = render(TIZEN);
  assert.equal(has(html, 'screenOffBtn'), false);
  assert.equal(has(html, 'screenOnBtn'), false);
  assert.equal(has(html, 'rebootBtn'), false);
  assert.equal(has(html, 'forceUpdateBtn'), false);
});

test('a BrightSign IS offered the screen power and reboot it genuinely has', () => {
  // The check that catches gating written as "hide everything that is not Android", which would
  // read as correct on every other test in this file.
  const html = render(BRIGHTSIGN);
  assert.ok(has(html, 'screenOffBtn'));
  assert.ok(has(html, 'screenOnBtn'));
  assert.ok(has(html, 'rebootBtn'));
});

test('an Android panel keeps the full control set', () => {
  const html = render(ANDROID_FULL);
  for (const id of ['rebootBtn', 'screenOffBtn', 'screenOnBtn', 'launchAppBtn', 'forceUpdateBtn',
    'screenshotBtn', 'startRemoteBtn', 'sysVolume', 'sysWinBrightness']) {
    assert.ok(has(html, id), `${id} must survive`);
  }
});

test('THE REGRESSION THAT MATTERS: an undeclared legacy display loses nothing', () => {
  // ~440 real displays declare nothing. If the gate reads "no declaration => supports nothing",
  // every one of them loses its entire control panel the moment this deploys — a far worse bug
  // than the one being fixed. The server resolves a per-platform baseline for them, and this
  // asserts the client renders whatever it is handed rather than second-guessing it.
  const legacyAndroid = { client_type: 'apk', android_version: '9' };   // no capabilities field
  const html = render(legacyAndroid);
  for (const id of ['rebootBtn', 'screenOffBtn', 'screenOnBtn', 'launchAppBtn', 'forceUpdateBtn',
    'screenshotBtn', 'startRemoteBtn']) {
    assert.ok(has(html, id), `${id} disappeared for a display that never declared anything`);
  }
});

test('the live view is hidden on a player that cannot capture, and the key pad is not', () => {
  // Start used to produce a canvas that stayed black forever, which reads as a dead panel rather
  // than as an unsupported feature. The D-pad still works there — it is a different mechanism.
  const html = render(TIZEN);
  assert.equal(has(html, 'startRemoteBtn'), false, 'no screenshot stream to start');
  assert.equal(has(html, 'remoteCanvas'), false, 'and no permanently black canvas');
  assert.ok(html.includes('KEYCODE_DPAD_CENTER'), 'key input is unaffected');
});

test('a player with no remote surface at all loses the whole Remote tab', () => {
  const blind = { platform: 'brightsign', capabilities: ['playback.video', 'audio.volume'] };
  const html = render(blind);
  assert.equal(html.includes('data-tab="remote"'), false, 'no tab');
  assert.equal(has(html, 'tab-remote'), false, 'and no orphaned tab body behind it');
});

test('a tab trigger is never rendered without its content, or the click blanks the page', () => {
  // setupTabs() does getElementById(`tab-${dataset.tab}`).classList.add(...) with no null check,
  // so a trigger whose body was gated away throws on click and leaves every tab deselected.
  for (const device of [WEB, TIZEN, BRIGHTSIGN, ANDROID_FULL, { client_type: 'apk' }]) {
    const html = render(device);
    for (const m of html.matchAll(/data-tab="([\w-]+)"/g)) {
      assert.ok(has(html, `tab-${m[1]}`),
        `tab "${m[1]}" has a trigger but no content for ${device.platform || device.android_version || 'apk'}`);
    }
  }
});

test('the capability list is shown, so a missing control is explainable', () => {
  // Hiding controls with no explanation just moves the confusion: "the reboot button vanished"
  // is a support ticket unless the page says what the panel reported.
  const html = render(TIZEN);
  assert.ok(html.includes('device.caps.title'));
  assert.ok(html.includes('remote.input'), 'the actual declared names are listed');
  assert.ok(html.includes('device.caps.declared'));

  const legacy = render({ client_type: 'apk' });
  assert.ok(legacy.includes('device.caps.assumed'),
    'and an undeclared display says so rather than presenting a guess as fact');
});

test('every gated control still renders balanced markup', () => {
  // A gate placed around an opening tag but not its close leaves the rest of the page inside a
  // stray element, which does not throw and does not show up in any assertion above.
  for (const device of [WEB, TIZEN, BRIGHTSIGN, ANDROID_FULL, { client_type: 'apk' },
    { platform: 'brightsign', capabilities: [] }]) {
    const html = render(device);
    const open = (html.match(/<div\b/g) || []).length;
    const close = (html.match(/<\/div>/g) || []).length;
    assert.equal(open, close,
      `unbalanced <div> for ${device.platform || device.android_version || 'apk'}: ${open} open, ${close} close`);
    const bopen = (html.match(/<button\b/g) || []).length;
    const bclose = (html.match(/<\/button>/g) || []).length;
    assert.equal(bopen, bclose, 'unbalanced <button>');
  }
});
