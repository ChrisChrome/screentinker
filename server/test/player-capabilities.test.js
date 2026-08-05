'use strict';

// The dashboard offered every control to every display. A browser tab cannot reboot its host, a
// Tizen TV has no device-owner concept, a BrightSign has no per-window brightness — so those
// buttons did nothing, silently. "UI that reports success and changes nothing" is a recurring bug
// shape here, and hiding an unsupported control is the fix.
//
// The risk in doing that is the opposite failure: stripping controls from the several hundred
// displays already in the field, none of which declare anything. So an ABSENT declaration falls
// back to a per-platform baseline, while an EMPTY one is honoured as a player genuinely saying it
// can do nothing. Those two cases are easy to conflate and the difference is a dark dashboard.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const caps = require('../lib/player-capabilities');

test('a legacy display with NO declaration keeps its platform baseline', () => {
  // The several-hundred-device case: they will not update before the next dashboard deploy.
  const android = { client_type: 'apk', android_version: '12' };
  assert.ok(caps.supports(android, 'system.reboot'));
  assert.ok(caps.supports(android, 'playback.video'));
});

test('THE DISTINCTION: an EMPTY declaration is honoured, not treated as missing', () => {
  // A player saying "I can do nothing" is a real answer — a widget with no host bridge, say — and
  // must not be quietly upgraded to the baseline.
  const d = { client_type: 'apk', capabilities: '[]' };
  assert.deepEqual(caps.capabilitiesFor(d), []);
  assert.equal(caps.supports(d, 'playback.video'), false);
});

test('a declaration overrides the baseline in BOTH directions', () => {
  // Android gains real screenshots only when accessibility is on, and loses Tier-2 commands when
  // it is not device owner. A static table could never know either.
  const restricted = { client_type: 'apk', capabilities: JSON.stringify(['playback.video']) };
  assert.equal(caps.supports(restricted, 'system.reboot'), false, 'declared set is authoritative');

  const enhanced = { platform: 'Chrome 120', capabilities: JSON.stringify(['playback.video', 'system.reboot']) };
  assert.ok(caps.supports(enhanced, 'system.reboot'), 'a web player behind a host CAN reboot');
});

test('a browser tab does not claim what it cannot do', () => {
  const web = { platform: 'Chrome 150', android_version: 'Web/Chrome' };
  assert.equal(caps.supports(web, 'system.reboot'), false);
  assert.equal(caps.supports(web, 'system.kiosk'), false);
  assert.equal(caps.supports(web, 'display.power'), false);
  assert.ok(caps.supports(web, 'playback.video'));
});

test('platform families are recognised from the same fields the rest of the product uses', () => {
  assert.equal(caps.platformFamily({ platform: 'brightsign' }), 'brightsign');
  assert.equal(caps.platformFamily({ platform: 'Tizen 6.0' }), 'tizen');
  assert.equal(caps.platformFamily({ client_type: 'apk' }), 'android');
  assert.equal(caps.platformFamily({ android_version: 'Android 12' }), 'android');
  assert.equal(caps.platformFamily({ android_version: 'Web/Safari' }), 'web');
  assert.equal(caps.platformFamily({}), 'web', 'unknown falls back to the most limited set');
});

test('an unknown capability from a NEWER player does not discard the ones we understand', () => {
  const d = { client_type: 'apk', capabilities: JSON.stringify(['playback.video', 'quantum.teleport']) };
  assert.deepEqual(caps.capabilitiesFor(d), ['playback.video']);
});

test('asking about a capability that does not exist is false, never a throw', () => {
  assert.equal(caps.supports({ client_type: 'apk' }, 'nonsense.capability'), false);
  assert.equal(caps.supports(null, 'playback.video'), false);
});

test('malformed declarations fall back rather than blanking the UI', () => {
  for (const bad of ['not json', '{"a":1}', '   ', 42]) {
    const d = { client_type: 'apk', capabilities: bad };
    assert.ok(caps.supports(d, 'playback.video'), `${JSON.stringify(bad)} must fall back to baseline`);
  }
});

test('every baseline entry is a real capability name', () => {
  // A typo here silently disables a control for a whole platform.
  for (const [family, list] of Object.entries(caps.BASELINE)) {
    for (const c of list) assert.ok(caps.CAP_SET.has(c), `${family} baseline has unknown capability ${c}`);
  }
});

test('BrightSign claims display power and reboot; Tizen claims neither', () => {
  // The concrete parity facts this whole model exists to express.
  const bs = { platform: 'brightsign' };
  const tizen = { platform: 'Tizen 6.5' };
  assert.ok(caps.supports(bs, 'display.power'));
  assert.ok(caps.supports(bs, 'system.reboot'));
  assert.equal(caps.supports(tizen, 'display.power'), false);
  assert.equal(caps.supports(tizen, 'system.reboot'), false);
});

test('Tizen does NOT claim offline caching — it caches the playlist, not the media', () => {
  // st_payload_cache holds the playlist JSON in localStorage; there is no service worker and no
  // media cache, so an outage leaves the panel with a playlist it cannot play. The first version
  // of this baseline claimed offline.cache, which is precisely the lie the model exists to stop.
  assert.equal(caps.supports({ platform: 'Tizen 6.5' }, 'offline.cache'), false);
  assert.ok(caps.supports({ client_type: 'apk' }, 'offline.cache'), 'Android really does cache media');
});
