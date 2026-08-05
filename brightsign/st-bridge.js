/*
 * ScreenTinker — BrightSign bridge (the JavaScript half of autorun.brs).
 *
 * Loaded by the web player only when it is running on a BrightSign. Everything here is a
 * capability the page cannot get on its own, plus one thing it must be STOPPED from doing:
 *
 *   - reload():  a page-initiated location.reload() does not reliably bring an roHtmlWidget
 *                back (a ScreenTinker deploy darkened a customer's player this way on
 *                2026-07-28). Ask the host to rebuild the widget instead.
 *   - identity:  the registry survives reboots, content updates and origin changes;
 *                localStorage does not. The hardware serial is the stable id, so two panels
 *                imaged from the same card never collide.
 *   - sync:      exposes which backend this deployment uses, so the player can run its own
 *                clock-derived group sync or defer to BrightSign's native BrightWall.
 *
 * Safe to load anywhere: if the @brightsign modules are absent (a desktop browser, or a widget
 * built without nodejs_enabled) every method degrades to a no-op or a sane default, and
 * isBrightSign() reports false. Nothing here may throw — this file loads before the player.
 */
(function (global) {
  'use strict';

  var HEARTBEAT_MS = 30000;

  function tryRequire(name) {
    try {
      // `require` exists only inside an roHtmlWidget created with nodejs_enabled:true
      if (typeof require !== 'function') return null;
      return require(name);
    } catch (e) {
      return null;
    }
  }

  var MessagePortClass = tryRequire('@brightsign/messageport');
  var RegistryClass = tryRequire('@brightsign/registry');
  var DeviceInfoClass = tryRequire('@brightsign/deviceinfo');
  var VideoOutputClass = tryRequire('@brightsign/videooutput');

  var port = null;
  if (MessagePortClass) {
    try { port = new MessagePortClass(); } catch (e) { port = null; }
  }

  // The UA check is the fallback for a widget without node integration: the player still needs
  // to know it is on a BrightSign so it can pick the right video and caching behaviour, even
  // when it cannot reach the host. Observed UA: "BrightSign/9.1.92.2 (HD1026) ... Chrome/120".
  var uaIsBrightSign = typeof navigator !== 'undefined' &&
    /BrightSign/i.test(navigator.userAgent || '');

  var listeners = [];
  if (port && typeof port.addEventListener === 'function') {
    try {
      port.addEventListener('bsmessage', function (msg) {
        for (var i = 0; i < listeners.length; i++) {
          try { listeners[i](msg); } catch (e) { /* one bad listener must not kill the rest */ }
        }
      });
    } catch (e) { /* no inbound channel; outbound may still work */ }
  }

  function post(obj) {
    if (!port || typeof port.PostBSMessage !== 'function') return false;
    try { port.PostBSMessage(obj); return true; } catch (e) { return false; }
  }

  var registry = null;
  if (RegistryClass) {
    try { registry = new RegistryClass(); } catch (e) { registry = null; }
  }

  function screenNumber() {
    try {
      var m = new RegExp('[?&]screen=([^&]*)').exec(global.location.search || '');
      var n = m ? parseInt(decodeURIComponent(m[1]), 10) : 1;
      return (isNaN(n) || n < 1) ? 1 : n;
    } catch (e) { return 1; }
  }

  /*
   * Registry keys are namespaced per output. On a dual-output player autorun.brs runs TWO
   * widgets against the same registry, the same SD storage_path and the same origin — so an
   * un-namespaced "device_id" would have both outputs adopt one identity and collapse into a
   * single device row. Screen 1 keeps the bare key so existing single-output panels are
   * unaffected.
   */
  function key(name) {
    var s = screenNumber();
    return s > 1 ? name + '_s' + s : name;
  }

  /*
   * The registry API is ASYNCHRONOUS and section-oriented:
   *   registry.read(section, key)      -> Promise<string>
   *   registry.write(section, {k: v})  -> Promise
   * (per @brightsign/registry in the dev-cookbook enable-ldws example and the trace-event docs).
   *
   * The player needs identity synchronously during boot, so the values are prefetched once into
   * a cache and every accessor reads the cache. Callers wait on whenReady() before trusting it.
   * Both shapes are tolerated — a Promise or a bare value — so a firmware that returns
   * synchronously still works rather than caching a Promise object as if it were a device id,
   * which would register a "[object Promise]" display.
   */
  var SECTION = 'screentinker';
  // device_token belongs here as much as device_id: the server authenticates the claim to an
  // existing display with the token, so an id presented without one reads as a NEW display and
  // gets a fresh row. Persisting the id alone looked correct and still spawned a duplicate on
  // every boot — found on hardware, not in a test.
  var CACHED_KEYS = ['device_id', 'device_token', 'server_url', 'sync_backend'];
  var cache = {};
  var ready = false;
  var readyWaiters = [];

  function markReady() {
    if (ready) return;
    ready = true;
    var waiters = readyWaiters;
    readyWaiters = [];
    for (var i = 0; i < waiters.length; i++) {
      try { waiters[i](); } catch (e) { /* one bad waiter must not block the rest */ }
    }
  }

  function normalise(v) {
    return (v === undefined || v === null || v === '') ? null : String(v);
  }

  function prefetch() {
    if (!registry) { markReady(); return; }
    var pending = CACHED_KEYS.length;
    var settle = function () { if (--pending <= 0) markReady(); };

    for (var i = 0; i < CACHED_KEYS.length; i++) {
      (function (name) {
        var result;
        try { result = registry.read(SECTION, key(name)); } catch (e) { settle(); return; }
        if (result && typeof result.then === 'function') {
          result.then(
            function (v) { cache[name] = normalise(v); settle(); },
            function () { settle(); }
          );
        } else {
          cache[name] = normalise(result);
          settle();
        }
      })(CACHED_KEYS[i]);
    }
  }

  function regGet(name, fallback) {
    var v = cache[name];
    return (v === undefined || v === null) ? fallback : v;
  }

  /* values: { device_id: 'x', ... } using UNPREFIXED names; the screen suffix is applied here. */
  function regSet(values) {
    var payload = {};
    for (var name in values) {
      if (!Object.prototype.hasOwnProperty.call(values, name)) continue;
      var v = values[name];
      payload[key(name)] = v === null || v === undefined ? '' : String(v);
      cache[name] = normalise(v);
    }
    if (!registry) return false;
    try {
      var r = registry.write(SECTION, payload);
      // A rejected write must not surface as an unhandled rejection on a signage player.
      if (r && typeof r.catch === 'function') r.catch(function () {});
      return true;
    } catch (e) { return false; }
  }

  var deviceInfo = null;
  if (DeviceInfoClass) {
    try { deviceInfo = new DeviceInfoClass(); } catch (e) { deviceInfo = null; }
  }

  function qs(name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location.search || '');
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }

  var API = {
    /* True only when this really is a BrightSign — either module access or the UA. */
    isBrightSign: function () {
      return !!(port || registry || deviceInfo || uaIsBrightSign);
    },

    /* True when the host bridge is live, i.e. restart/identity/sync calls will be honoured. */
    hasHost: function () { return !!port; },

    /*
     * The stable hardware identity. autorun.brs passes it on the URL so it is available even
     * before the modules resolve; the module is the authority when both exist.
     */
    serial: function () {
      if (deviceInfo) {
        try {
          var s = deviceInfo.serialNumber || (deviceInfo.getDeviceUniqueId && deviceInfo.getDeviceUniqueId());
          if (s) return String(s);
        } catch (e) { /* fall through to the URL */ }
      }
      return qs('serial') || null;
    },

    model: function () {
      if (deviceInfo) {
        try { if (deviceInfo.model) return String(deviceInfo.model); } catch (e) { /* fall through */ }
      }
      return qs('model') || null;
    },

    osVersion: function () {
      if (deviceInfo) {
        try { if (deviceInfo.osVersion) return String(deviceInfo.osVersion); } catch (e) { /* ignore */ }
      }
      return null;
    },

    /* Which physical output this widget is painting. 1 unless autorun.brs made a second one. */
    screen: screenNumber,

    /*
     * Suffix callers should append to any per-display storage key. Two widgets on one player
     * share an origin and therefore share localStorage, so the config, playlist cache and
     * install salt all need separating or the second output silently becomes the first.
     */
    storageSuffix: function () {
      var s = screenNumber();
      return s > 1 ? '_s' + s : '';
    },

    /*
     * Persisted device id. Registry first (survives a card re-image with the same registry),
     * then the URL, then localStorage for the browser case.
     */
    deviceId: function () {
      var v = regGet('device_id', null) || qs('device_id');
      if (v) return v;
      try { return global.localStorage.getItem('st_device_id'); } catch (e) { return null; }
    },

    /* The credential that proves this player IS that display. Useless without deviceId, and
       deviceId is useless without it. */
    deviceToken: function () { return regGet('device_token', null); },

    /* Called once pairing completes, so a reboot comes back as the same display. */
    setIdentity: function (deviceId, serverUrl, deviceToken) {
      var values = {};
      if (deviceId) values.device_id = deviceId;
      if (serverUrl) values.server_url = serverUrl;
      if (deviceToken) values.device_token = deviceToken;
      regSet(values);
      post({ type: 'identity', device_id: deviceId || null, server_url: serverUrl || null });
    },

    /*
     * Forget this display. Required for the operator reset to mean anything: the registry
     * outlives localStorage, so clearing local storage alone would leave the panel re-adopting
     * the same identity on its next boot — a reset that resets nothing.
     */
    clearIdentity: function () {
      regSet({ device_id: '', device_token: '' });
      return post({ type: 'identity', clear: true });
    },

    /*
     * THE reload replacement. Never call location.reload() on this platform.
     * Returns false if there is no host, so the caller can decide whether reloading in place
     * is better than doing nothing (in a plain browser, it is).
     */
    restart: function (reason) {
      return post({ type: 'restart', reason: reason || 'unspecified' });
    },

    reboot: function () { return post({ type: 'reboot' }); },

    /*
     * Which sync protocol this deployment runs. Resolved by the server
     * (server/lib/sync-backend.js) and pushed down; the registry holds the last known value so
     * a cold boot with no network still starts in the right mode.
     *   'screentinker' — our clock-derived group sync; the only option in a mixed fleet.
     *   'brightsign'   — native BrightWall; the host drives it over the bridge.
     */
    syncBackend: function () {
      return qs('sync_backend') || regGet('sync_backend', 'auto');
    },

    setSyncBackend: function (backend) {
      if (!backend) return false;
      regSet({ sync_backend: backend });
      return post({ type: 'set-sync-backend', backend: backend });
    },

    /*
     * Identity readiness. The registry is async, so a caller that registers with the server
     * before this resolves would pair as a NEW display and leave a duplicate row behind. The
     * callback always runs — on success, on failure, or off-platform — so nothing can hang the
     * player waiting for hardware that isn't there.
     */
    isReady: function () { return ready; },

    onReady: function (fn) {
      if (typeof fn !== 'function') return;
      if (ready) { try { fn(); } catch (e) { /* ignore */ } return; }
      readyWaiters.push(fn);
    },

    setVideoMode: function (mode) {
      if (VideoOutputClass) {
        try {
          var vo = new VideoOutputClass();
          if (vo && typeof vo.setMode === 'function') { vo.setMode(mode); return true; }
        } catch (e) { /* fall back to the host */ }
      }
      return post({ type: 'set-video-mode', mode: mode });
    },

    onHostMessage: function (fn) { if (typeof fn === 'function') listeners.push(fn); },

    /*
     * Heartbeat. autorun.brs rebuilds the widget after three missed beats, which is what
     * recovers a page that loaded fine and then wedged (dead socket, JS exception, decoder
     * stall) — a case load-error never reports.
     */
    startHeartbeat: function () {
      if (!port) return;
      var beat = function () { post({ type: 'heartbeat', t: Date.now() }); };
      beat();
      return global.setInterval(beat, HEARTBEAT_MS);
    }
  };

  global.ScreenTinkerBS = API;

  // Kick the registry prefetch immediately, and never let a silent module hold boot: the player
  // stops waiting after this and carries on with whatever identity it has.
  prefetch();
  if (global.setTimeout) global.setTimeout(markReady, 5000);

  if (API.hasHost()) API.startHeartbeat();
})(typeof window !== 'undefined' ? window : this);
