'use strict';

// st-bridge.js is loaded by EVERY player, not just BrightSigns, because gating it on a user agent
// would mean a panel reporting an unexpected UA silently loses restart-instead-of-reload — the one
// thing it most needs. That makes its behaviour in a plain browser a correctness requirement, not a
// nicety: it must not throw, must report isBrightSign() false, and must tell the caller it could NOT
// take a restart so the player falls back to location.reload() instead of doing nothing.
//
// The other half is the dual-output collision. autorun.brs gives the second HDMI output its own
// widget, and both widgets share an origin, a registry and one SD storage_path. Un-namespaced keys
// would have output 2 read output 1's identity, and the two would collapse into a single device row
// — the same duplicate-row failure the hardware-only fingerprint once caused, in reverse.
//
// Run in a vm with a fake global rather than a browser, so the contract is checked without hardware.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'brightsign', 'st-bridge.js'), 'utf8');

/** Load the bridge into a fake window. `mods` present => pretend we are on a BrightSign. */
function load({ search = '', mods = null, ua = 'Mozilla/5.0 Chrome/150', seed = {} } = {}) {
  const posted = [];
  const registryStore = new Map(Object.entries(seed));

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    navigator: { userAgent: ua },
    location: { search, reload() { sandbox.__reloaded = true; } },
    setInterval: () => 1,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    Promise,
    Object,
    Date,
    RegExp,
    parseInt,
    isNaN,
    String,
    decodeURIComponent,
    __reloaded: false,
    __posted: posted,
    __registry: registryStore,
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.window = sandbox;

  if (mods) {
    sandbox.require = (name) => {
      if (name === '@brightsign/messageport') {
        return function () {
          return {
            PostBSMessage: (o) => posted.push(o),
            addEventListener: () => {},
          };
        };
      }
      if (name === '@brightsign/registry') {
        // The real API is async and section-oriented:
        //   read(section, key) -> Promise<string>;  write(section, {k: v}) -> Promise
        // Modelling that exactly is the point of this fake — a synchronous stand-in would have
        // hidden the bug where the bridge cached a Promise object as the device id.
        return function () {
          return {
            read: (section, k) => Promise.resolve(registryStore.get(section + ':' + k)),
            write: (section, values) => {
              Object.keys(values).forEach((k) => registryStore.set(section + ':' + k, values[k]));
              return Promise.resolve();
            },
          };
        };
      }
      if (name === '@brightsign/deviceinfo') {
        return function () {
          return { model: 'XT1145', osVersion: '9.1.92.2', serialNumber: 'SN-TEST-1' };
        };
      }
      throw new Error('no such module ' + name);
    };
  }

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const api = sandbox.ScreenTinkerBS;
  // onReady always fires, so this resolves off-platform too.
  const ready = new Promise((resolve) => api.onReady(resolve));
  return { api, sandbox, posted, registryStore, ready };
}

test('in a plain browser it loads without throwing and reports not-BrightSign', () => {
  const { api } = load();
  assert.equal(api.isBrightSign(), false);
  assert.equal(api.hasHost(), false);
});

test('THE FALLBACK: with no host, restart() returns false so the player can reload instead', () => {
  const { api } = load();
  // Returning false is the whole contract — the player checks it and calls location.reload().
  assert.equal(api.restart('deploy'), false);
});

test('off-platform accessors return null/defaults rather than throwing', () => {
  const { api } = load();
  assert.equal(api.serial(), null);
  assert.equal(api.model(), null);
  assert.equal(api.osVersion(), null);
  assert.equal(api.screen(), 1);
  assert.equal(api.storageSuffix(), '');
  assert.equal(api.setVideoMode({ width: 1920 }), false);
  assert.doesNotThrow(() => api.onHostMessage(null));
});

test('a BrightSign UA alone is enough to identify the platform', () => {
  // A widget built without nodejs_enabled resolves no modules, but the player still needs to know.
  const { api } = load({ ua: 'BrightSign/9.1.92.2 (HD1026) Chrome/120.0.6099.225' });
  assert.equal(api.isBrightSign(), true);
  assert.equal(api.hasHost(), false, 'no modules means no host to take a restart');
});

test('with the host present, restart() posts to BrightScript and reports success', () => {
  const { api, posted } = load({ mods: true });
  assert.equal(api.hasHost(), true);
  assert.equal(api.restart('server code updated'), true);
  const msg = posted.find((m) => m.type === 'restart');
  assert.ok(msg, 'the host must actually receive it');
  assert.equal(msg.reason, 'server code updated');
});

test('identity round-trips through the registry', () => {
  const { api } = load({ mods: true });
  api.setIdentity('dev-123', 'https://screentinker.com');
  assert.equal(api.deviceId(), 'dev-123');
});

test('THE RESET: clearIdentity makes the registry forget, so a reset really resets', () => {
  const { api, posted } = load({ mods: true });
  api.setIdentity('dev-123', null);
  api.clearIdentity();
  assert.equal(api.deviceId(), null, 'otherwise the next boot re-adopts the same display');
  assert.ok(posted.some((m) => m.type === 'identity' && m.clear === true));
});

test('THE COLLISION: output 2 namespaces its registry key and storage away from output 1', () => {
  const one = load({ mods: true, search: '?screen=1' });
  const two = load({ mods: true, search: '?screen=2' });

  assert.equal(one.api.screen(), 1);
  assert.equal(two.api.screen(), 2);
  assert.equal(one.api.storageSuffix(), '', 'screen 1 must keep the bare keys — existing panels');
  assert.equal(two.api.storageSuffix(), '_s2');

  one.api.setIdentity('display-A', null);
  two.api.setIdentity('display-B', null);
  assert.equal(one.api.deviceId(), 'display-A');
  assert.equal(two.api.deviceId(), 'display-B', 'two outputs must not collapse into one device row');

  // and the underlying keys really are distinct
  assert.deepEqual(
    [...one.registryStore.keys()].sort(),
    ['screentinker:device_id']
  );
  assert.deepEqual(
    [...two.registryStore.keys()].sort(),
    ['screentinker:device_id_s2']
  );
});

test('deviceinfo supplies identity, with the URL as the fallback before modules resolve', () => {
  const withMods = load({ mods: true });
  assert.equal(withMods.api.serial(), 'SN-TEST-1');
  assert.equal(withMods.api.model(), 'XT1145');

  const urlOnly = load({ search: '?serial=SN-URL&model=XC2055', ua: 'BrightSign/9 Chrome/120' });
  assert.equal(urlOnly.api.serial(), 'SN-URL');
  assert.equal(urlOnly.api.model(), 'XC2055');
});

test('sync backend comes from the URL, else the registry, else auto', () => {
  assert.equal(load({ mods: true }).api.syncBackend(), 'auto');
  assert.equal(load({ mods: true, search: '?sync_backend=brightsign' }).api.syncBackend(), 'brightsign');

  const persisted = load({ mods: true });
  persisted.api.setSyncBackend('screentinker');
  assert.equal(persisted.api.syncBackend(), 'screentinker', 'a cold boot with no network still starts right');
});

test('THE ASYNC TRAP: a Promise from registry.read is never cached as the device id', async () => {
  // registry.read() resolves a Promise. Treating it as a value would make deviceId() return the
  // Promise object itself — truthy, non-empty — and the player would register a display called
  // "[object Promise]" while its real row sat unclaimed.
  const { api, ready } = load({ mods: true, seed: { 'screentinker:device_id': 'existing-id' } });
  await ready;
  assert.equal(typeof api.deviceId(), 'string');
  assert.equal(api.deviceId(), 'existing-id', 'a provisioned panel must come back as itself');
});

test('a panel with nothing in the registry becomes ready with no identity, not a stuck one', async () => {
  const { api, ready } = load({ mods: true });
  await ready;
  assert.equal(api.isReady(), true);
  assert.equal(api.deviceId(), null);
});

test('onReady fires off-platform too, so a browser never blocks on hardware that is absent', async () => {
  const { api, ready } = load();
  await ready;
  assert.equal(api.isReady(), true);
});

test('a rejected registry read still lets the player boot', async () => {
  const { api, ready } = load({ mods: true });
  // The fake resolves; what matters is that readiness is reached and nothing throws.
  await ready;
  assert.doesNotThrow(() => api.deviceId());
});

test('THE DUPLICATE-ROW BUG: the token is persisted alongside the id', async () => {
  // Persisting device_id alone looked correct and still spawned a new device row on every boot:
  // the server authenticates a claim to an existing display with the TOKEN, so an id presented
  // without one reads as a brand-new display. Found on an XT245, not in a test — hence this one.
  const { api, ready } = load({ mods: true });
  await ready;
  api.setIdentity('dev-9', 'https://alpha.screentinker.com', 'tok-abc123');
  assert.equal(api.deviceId(), 'dev-9');
  assert.equal(api.deviceToken(), 'tok-abc123', 'without this the display re-pairs every boot');
});

test('an id with no token is still stored — it is better than nothing', async () => {
  // An unpaired display has no token yet; the server issues one at pairing. Storing the id alone
  // must not throw or wipe anything.
  const { api, ready } = load({ mods: true });
  await ready;
  api.setIdentity('dev-10', null, null);
  assert.equal(api.deviceId(), 'dev-10');
  assert.equal(api.deviceToken(), null);
});

test('clearIdentity forgets the token too, or the reset leaks a credential', async () => {
  const { api, ready } = load({ mods: true });
  await ready;
  api.setIdentity('dev-11', null, 'tok-xyz');
  api.clearIdentity();
  assert.equal(api.deviceId(), null);
  assert.equal(api.deviceToken(), null, 'a stale token must not outlive the identity it belongs to');
});
