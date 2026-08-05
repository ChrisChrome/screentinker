'use strict';

/*
 * What a player can actually do.
 *
 * The dashboard offered every control to every display. A browser tab cannot reboot its host, a
 * Tizen TV has no device-owner concept, a BrightSign has no per-window brightness — so those
 * buttons did nothing, silently, and looked like bugs. "UI that reports success and changes
 * nothing" is a recurring shape in this codebase and this module exists to end it.
 *
 * The player DECLARES its capabilities at registration, because only the player knows at runtime:
 * an Android device gains real screenshots when accessibility is switched on, and loses Tier-2
 * commands when it is not device owner. A static per-platform table could never know that.
 *
 * ⚠️ Legacy displays declare nothing. A fleet of several hundred is not going to update before the
 * next dashboard deploy, so an absent declaration falls back to a per-platform baseline rather
 * than to "supports nothing" — which would strip the UI for every existing display at once. The
 * baseline is deliberately optimistic for things that always worked, and pessimistic for anything
 * that depends on runtime state.
 */

/*
 * The vocabulary. Stable strings, because they are persisted per device and sent over the wire —
 * renaming one silently disables a control on every display that still reports the old name.
 * Grouped by what the operator is trying to do, not by how it is implemented.
 */
const CAPABILITIES = [
  // playback surface
  'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
  'playback.zones', 'playback.transitions', 'playback.pip',
  // audio
  'audio.mute', 'audio.volume',
  // display
  'display.rotation', 'display.power', 'display.resolution',
  // remote view / control
  'remote.screenshot', 'remote.stream', 'remote.input',
  // lifecycle
  'system.reboot', 'system.restart_player', 'system.self_update',
  // device management (Android device-owner territory)
  'system.kiosk', 'system.brightness', 'system.screen_timeout',
  'system.install_apk', 'system.shell', 'system.time',
  // synchronisation
  'sync.clock', 'sync.native',
  // resilience
  'offline.cache',
];

const CAP_SET = new Set(CAPABILITIES);

/*
 * Baselines for displays that declare nothing.
 *
 * Only things that have always worked on that platform. Anything conditional — screenshots that
 * need accessibility, kiosk that needs device owner, native sync that needs one L2 network — is
 * omitted, so a legacy display shows those controls only once it declares them. Better a control
 * that appears late than one that lies today.
 */
const BASELINE = {
  android: [
    'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
    'playback.zones', 'playback.transitions', 'playback.pip',
    'audio.mute', 'audio.volume',
    'display.rotation', 'display.power',
    'remote.screenshot', 'remote.stream', 'remote.input',
    'system.reboot', 'system.restart_player', 'system.self_update',
    'sync.clock', 'offline.cache',
  ],
  tizen: [
    'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
    'playback.zones', 'playback.transitions', 'playback.pip',
    'audio.mute', 'audio.volume',
    'display.rotation',
    'remote.input',
    'system.restart_player',
    'sync.clock',
    // NOT offline.cache: Tizen caches only the playlist JSON (st_payload_cache in localStorage).
    // There is no service worker and no media cache, so the bytes still come from the network and
    // content does NOT survive an outage. My first baseline claimed it — caught by the platform
    // audit, and exactly the kind of optimistic claim this model exists to stop.
  ],
  brightsign: [
    'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
    'playback.zones', 'playback.transitions', 'playback.pip',
    'audio.mute', 'audio.volume',
    'display.rotation', 'display.power',
    'remote.input',
    'system.reboot', 'system.restart_player',
    'sync.clock', 'offline.cache',
  ],
  // A browser tab. Deliberately the smallest set: it cannot reboot its host, rotate a panel, or
  // capture anything outside its own document.
  web: [
    'playback.video', 'playback.image', 'playback.widget', 'playback.youtube',
    'playback.zones', 'playback.transitions', 'playback.pip',
    'audio.mute', 'audio.volume',
    'display.rotation',
    'remote.screenshot', 'remote.stream', 'remote.input',
    'system.restart_player',
    'sync.clock', 'offline.cache',
  ],
};

/*
 * Which baseline a device falls back to. Keyed off the same `platform` field the sync resolver
 * uses, so a device is classified one way across the whole product.
 */
function platformFamily(device) {
  const platform = String((device && device.platform) || '').toLowerCase();
  const android = String((device && device.android_version) || '');
  if (platform.includes('brightsign')) return 'brightsign';
  if (platform.includes('tizen')) return 'tizen';
  // client_type 'apk' is the Android player; android_version that is NOT the web player's
  // "Web/..." shape is the older signal for the same thing.
  if ((device && device.client_type === 'apk') || (android && !android.startsWith('Web/'))) return 'android';
  return 'web';
}

/**
 * The capability set for a device, as an array of known capability strings.
 *
 * @param {object} device  a device row; may carry `capabilities` (JSON array or string)
 * @returns {string[]}
 */
function capabilitiesFor(device) {
  const declared = parseDeclared(device && device.capabilities);
  if (declared) return declared;
  return (BASELINE[platformFamily(device)] || BASELINE.web).slice();
}

/**
 * True when the device supports `cap`. Unknown capability names are always false.
 *
 * A missing device supports nothing. It would otherwise fall through to the web baseline and
 * claim video playback for a row that does not exist — a caller rendering controls from a failed
 * lookup should get an empty panel, not a plausible-looking one.
 */
function supports(device, cap) {
  if (!device) return false;
  if (!CAP_SET.has(cap)) return false;
  return capabilitiesFor(device).includes(cap);
}

/*
 * Parse whatever the device sent. Returns null when there is no usable declaration, which is the
 * signal to fall back to the baseline — distinct from an EMPTY declaration, which is a player
 * genuinely saying "I can do nothing" and must be honoured.
 */
function parseDeclared(raw) {
  if (raw === null || raw === undefined) return null;
  let list = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try { list = JSON.parse(trimmed); } catch (e) { return null; }
  }
  if (!Array.isArray(list)) return null;
  // Unknown strings are dropped rather than rejected wholesale: a newer player declaring a
  // capability this server has never heard of must not lose the ones it does understand.
  return list.filter((c) => CAP_SET.has(c));
}

module.exports = { CAPABILITIES, CAP_SET, BASELINE, capabilitiesFor, supports, platformFamily, parseDeclared };
