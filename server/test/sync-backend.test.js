'use strict';

// A group can only run the protocol its weakest member supports.
//
// BrightWall is BrightSign's native synchronisation: frame-accurate, and exclusive to BrightSign
// hardware. ScreenTinker's own group sync derives every member's position from a shared clock, so it
// spans Android, web, Tizen and BrightSign, survives a server outage, and syncs to the second rather
// than the frame.
//
// The trap this guards is the mixed group. Selecting native sync for a wall that contains one Android
// panel cannot work — and the failure would be invisible from the dashboard, because the BrightSigns
// would look perfectly synchronised while the odd panel drifted on its own. So that combination
// downgrades and reports why, instead of being accepted and half-applied.
//
// Kept pure: no fleet, no sockets, just device rows in and a decision out.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveSyncBackend, isBrightSignDevice } = require('../lib/sync-backend');

const bs = (n = 1) => ({ id: `bs${n}`, platform: 'brightsign', name: `BrightSign ${n}` });
const android = { id: 'a1', platform: 'Android 12', name: 'Lobby tablet' };
const web = { id: 'w1', platform: 'Chrome 150', name: 'Test web' };

test('auto picks native sync when every display is a BrightSign', () => {
  const r = resolveSyncBackend('auto', [bs(1), bs(2), bs(3)]);
  assert.equal(r.backend, 'brightsign');
  assert.equal(r.downgraded, false);
});

test('auto falls back to our protocol the moment one member is not a BrightSign', () => {
  const r = resolveSyncBackend('auto', [bs(1), bs(2), android]);
  assert.equal(r.backend, 'screentinker');
  assert.equal(r.reason, 'mixed fleet');
});

test('THE TRAP: native sync explicitly selected for a mixed group downgrades and says why', () => {
  const r = resolveSyncBackend('brightsign', [bs(1), bs(2), android]);
  assert.equal(r.backend, 'screentinker', 'BrightWall cannot include a non-BrightSign screen');
  assert.equal(r.downgraded, true);
  assert.match(r.reason, /1 non-BrightSign display$/, 'the operator must be told which way it broke');
});

test('the downgrade message counts the offenders and pluralises', () => {
  const r = resolveSyncBackend('brightsign', [bs(1), android, web]);
  assert.match(r.reason, /2 non-BrightSign displays$/);
});

test('our protocol is honoured on an all-BrightSign group — never overridden', () => {
  // A 100% BrightSign site still gets to choose ours, e.g. to stay consistent with other sites.
  const r = resolveSyncBackend('screentinker', [bs(1), bs(2)]);
  assert.equal(r.backend, 'screentinker');
  assert.equal(r.downgraded, false);
});

test('an empty group never claims native sync', () => {
  assert.equal(resolveSyncBackend('auto', []).backend, 'screentinker');
  const forced = resolveSyncBackend('brightsign', []);
  assert.equal(forced.backend, 'screentinker');
  assert.equal(forced.downgraded, true);
});

test('unknown or missing settings read as auto rather than throwing', () => {
  assert.equal(resolveSyncBackend('nonsense', [bs(1)]).backend, 'brightsign');
  assert.equal(resolveSyncBackend(undefined, [android]).backend, 'screentinker');
  assert.equal(resolveSyncBackend('auto', null).backend, 'screentinker');
});

test('a player paired before the port is still recognised by its user agent', () => {
  // Both of giyokun's devices registered platform "Chrome 120" with a BrightSign UA.
  const legacy = { id: 'old', platform: 'Chrome 120', user_agent: 'BrightSign/9.1.92.2 (HD1026) Chrome/120' };
  assert.equal(isBrightSignDevice(legacy), true);
  assert.equal(resolveSyncBackend('auto', [legacy, bs(2)]).backend, 'brightsign');
});

test('a non-BrightSign device is never mistaken for one', () => {
  assert.equal(isBrightSignDevice(android), false);
  assert.equal(isBrightSignDevice(null), false);
  assert.equal(isBrightSignDevice({}), false);
});
