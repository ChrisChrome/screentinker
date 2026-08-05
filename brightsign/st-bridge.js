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

  function regRead(key, fallback) {
    if (!registry) return fallback;
    try {
      var v = registry.read('screentinker', key);
      return (v === undefined || v === null || v === '') ? fallback : v;
    } catch (e) { return fallback; }
  }

  function regWrite(key, value) {
    if (!registry) return false;
    try { registry.write('screentinker', key, String(value)); return true; } catch (e) { return false; }
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
    screen: function () {
      var n = parseInt(qs('screen') || '1', 10);
      return (isNaN(n) || n < 1) ? 1 : n;
    },

    /*
     * Persisted device id. Registry first (survives a card re-image with the same registry),
     * then the URL, then localStorage for the browser case.
     */
    deviceId: function () {
      var v = regRead('device_id', null) || qs('device_id');
      if (v) return v;
      try { return global.localStorage.getItem('st_device_id'); } catch (e) { return null; }
    },

    /* Called once pairing completes, so a reboot comes back as the same display. */
    setIdentity: function (deviceId, serverUrl) {
      if (deviceId) regWrite('device_id', deviceId);
      if (serverUrl) regWrite('server_url', serverUrl);
      post({ type: 'identity', device_id: deviceId || null, server_url: serverUrl || null });
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
      return qs('sync_backend') || regRead('sync_backend', 'auto');
    },

    setSyncBackend: function (backend) {
      if (!backend) return false;
      regWrite('sync_backend', backend);
      return post({ type: 'set-sync-backend', backend: backend });
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

  if (API.hasHost()) API.startHeartbeat();
})(typeof window !== 'undefined' ? window : this);
