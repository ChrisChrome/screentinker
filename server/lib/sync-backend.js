'use strict';

/*
 * Which synchronisation protocol a group runs.
 *
 * ScreenTinker has its own group sync: every member derives its position from a shared clock,
 * so it needs no leader, survives a server outage, and works across Android, web, Tizen and
 * BrightSign alike. BrightSign has its own — BrightWall — which is native, frame-accurate, and
 * only exists between BrightSign players.
 *
 * The choice is therefore not "which is better" but "what is in this group":
 *
 *   screentinker  works everywhere, mixed fleets included; sync is to the second, not the frame
 *   brightsign    frame-accurate video walls; requires EVERY member to be a BrightSign
 *
 * `auto` picks the strongest protocol the group can actually run, which is what an operator
 * means when they say "just make the wall work". Explicit settings are honoured, except the one
 * that cannot physically work (native sync with a non-BrightSign member) — that downgrades and
 * says why, rather than silently doing nothing on the screens that can't participate.
 *
 * Kept pure so the decision is testable without a fleet: callers pass plain device rows.
 */

const BACKENDS = ['auto', 'screentinker', 'brightsign'];

/*
 * A device is a BrightSign if it said so. The player sends ?platform=brightsign (autorun.brs
 * puts it there), which lands in devices.platform. The UA fallback covers players paired before
 * the port existed — those registered a platform of "Chrome 120" with a BrightSign UA.
 */
function isBrightSignDevice(device) {
  if (!device) return false;
  const platform = String(device.platform || '').toLowerCase();
  if (platform.includes('brightsign')) return true;
  const ua = String(device.user_agent || '').toLowerCase();
  return ua.includes('brightsign');
}

/**
 * @param {string} setting  'auto' | 'screentinker' | 'brightsign' (unknown values read as auto)
 * @param {Array}  members  device rows in the group
 * @returns {{backend: 'screentinker'|'brightsign', reason: string, downgraded: boolean}}
 */
function resolveSyncBackend(setting, members) {
  const list = Array.isArray(members) ? members.filter(Boolean) : [];
  const requested = BACKENDS.includes(setting) ? setting : 'auto';

  const brightsignCount = list.filter(isBrightSignDevice).length;
  const allBrightSign = list.length > 0 && brightsignCount === list.length;

  if (requested === 'screentinker') {
    return { backend: 'screentinker', reason: 'explicitly selected', downgraded: false };
  }

  if (requested === 'brightsign') {
    if (allBrightSign) {
      return { backend: 'brightsign', reason: 'explicitly selected', downgraded: false };
    }
    // Refusing to pretend: BrightWall cannot include a non-BrightSign screen, and a group that
    // half-syncs is worse than one that syncs to the second everywhere.
    const others = list.length - brightsignCount;
    return {
      backend: 'screentinker',
      reason: list.length === 0
        ? 'group is empty — native sync needs BrightSign members'
        : `group has ${others} non-BrightSign display${others === 1 ? '' : 's'}`,
      downgraded: true
    };
  }

  // auto
  if (allBrightSign) {
    return { backend: 'brightsign', reason: 'every display is a BrightSign', downgraded: false };
  }
  return {
    backend: 'screentinker',
    reason: list.length === 0 ? 'no displays in the group' : 'mixed fleet',
    downgraded: false
  };
}

module.exports = { resolveSyncBackend, isBrightSignDevice, BACKENDS };
