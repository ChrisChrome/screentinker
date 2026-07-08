import { t } from './i18n.js';

// HTML escape helper — prevents XSS when inserting user data into innerHTML
export function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// v4 liveness badge. The patch4 server derives a 3-state liveness — 'healthy' / 'degraded'
// (temporarily reconnecting) / 'offline' — and emits it as `data.liveness` on dashboard:device-status.
// It is present on SOME emits only (the plain reconnect + disconnect emits, and any device object read
// from the DB, carry just the binary `status`), so we DEGRADE to the binary status when liveness is
// absent — nothing ever renders blank. 'provisioning' is a lifecycle state (never-paired), kept
// distinct from liveness. livenessState() is pure (unit-testable); livenessBadge() adds the i18n label.
const LIVENESS_LABEL_KEY = {
  healthy: 'device.liveness.healthy',
  degraded: 'device.liveness.degraded',
  offline: 'device.liveness.offline',
  provisioning: 'dashboard.awaiting_pairing',
};
export function livenessState(data) {
  const lv = data && data.liveness;
  if (lv === 'healthy' || lv === 'degraded' || lv === 'offline') return lv;  // 3-state signal present
  const st = data && data.status;                     // backward-compat: derive from binary status
  if (st === 'provisioning') return 'provisioning';
  if (st === 'online') return 'healthy';
  if (st === 'offline') return 'offline';
  return 'offline';                                   // unknown / no data yet -> safe default, never blank
}
export function livenessBadge(data) {
  const state = livenessState(data);
  return { state, label: t(LIVENESS_LABEL_KEY[state]) };
}

// Phase 2.1: the Phase 1 schema migration renamed the legacy 'superadmin'
// role to 'platform_admin'. Existing frontend checks still match the old
// string; this helper accepts both so we don't have to splatter the array
// at every call site. Use everywhere the UI gates on platform-level access.
export function isPlatformAdmin(user) {
  return !!(user && (user.role === 'superadmin' || user.role === 'platform_admin'));
}
