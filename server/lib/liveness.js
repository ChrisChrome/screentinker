'use strict';

// v4 CORE-PASS liveness helpers — pure, VERSION-AGNOSTIC, mixed-fleet-safe. Dependency-free so they
// are unit-testable and the imperative shells (deviceSocket heartbeat/register handlers, the
// heartbeat offline sweep) stay thin. The server talks to a MIX simultaneously — v4 clients (have a
// watchdog, consume the ack, send an identity block), OLD pre-v4 clients (none of that), and
// genuinely-disconnected devices — and none of these may break the server or each other.

// ── Uniform ack (PRIMARY + FIX 1: reconnect-window gap) ────────────────────────────────────────
// Should THIS device:heartbeat be acked with device:heartbeat-ack? The ack keeps a v4 client's
// watchdog armed; it is emitted from the SHARED heartbeat handler (uniform by construction across
// APK / .wgt / /player) and is HARMLESS to old clients (they don't consume it). We ack a KNOWN
// device — identity-agnostic:
//   - an already-authenticated socket (authedDeviceId set), OR
//   - a heartbeat carrying a device_id that RESOLVES to a real device (a real device mid-reconnect,
//     BEFORE this socket finished re-registering — the deferred ack-gap fix).
// We do NOT ack anonymous / never-authenticated sockets (no device_id, or an unknown id): those are
// covered by degrade-safe — an un-acked client's watchdog simply never arms, so there is no
// false-fire and no storm.
function ackableHeartbeat(authedDeviceId, heartbeatDeviceId, deviceExists) {
  if (authedDeviceId) return true;                    // authenticated socket -> known
  if (!heartbeatDeviceId) return false;               // anonymous heartbeat -> not acked
  return !!deviceExists(heartbeatDeviceId);           // real device mid-reconnect -> ack (window fix)
}

// ── Dashboard liveness (FIX 2: server-derived, VERSION-AGNOSTIC 3-state) ────────────────────────
// Derived ONLY from signals EVERY client sends — socket presence, last-heartbeat age, reconnect
// frequency — never from v4-only signals. Correct for v4 clients, OLD clients (connected +
// heartbeating -> healthy), and disconnected clients (-> offline, a normal state, NOT an error).
//   offline  : no live socket.
//   degraded : connected but reconnecting frequently (churn), OR connected but silent past the window.
//   healthy  : connected + a recent heartbeat + not churning.
const HEALTHY_HEARTBEAT_MS = 35000;   // 2× the 15s client heartbeat + margin
const DEGRADED_RECONNECTS = 3;        // >=3 (re)registers within the reconnect window => churn

function deriveLiveness({ connected, lastHeartbeatAgeMs, recentReconnects } = {}, opts = {}) {
  const hbMax = opts.healthyHeartbeatMs != null ? opts.healthyHeartbeatMs : HEALTHY_HEARTBEAT_MS;
  const churn = opts.degradedReconnects != null ? opts.degradedReconnects : DEGRADED_RECONNECTS;
  if (!connected) return 'offline';
  if ((recentReconnects || 0) >= churn) return 'degraded';
  if ((lastHeartbeatAgeMs || 0) > hbMax) return 'degraded';
  return 'healthy';
}

// ── Identity capture (FIX 3: capture-don't-act, DEGRADES on missing) ────────────────────────────
// Capture the v4 identity block when present; when absent/partial (an OLD client), fill
// "legacy"/"unknown" — NEVER fail on a missing field. No logic is built on this yet.
function captureIdentity(data) {
  const d = data || {};
  return {
    client_type: d.client_type || 'legacy',
    client_version: d.client_version || 'unknown',
    platform: d.platform || 'unknown',
    contract_version: d.contract_version || 'legacy',
  };
}

// A1 change-detection: has the (already-captured) identity changed vs what's stored? A genuine
// reconnect with an unchanged identity (the common case) then does NO write. A never-stored device
// (current null / all-NULL columns) or a real change (e.g. new client_version after an OTA) writes.
function identityChanged(current, incoming) {
  if (!current) return true;
  return current.client_type !== incoming.client_type
    || current.client_version !== incoming.client_version
    || current.platform !== incoming.platform
    || current.contract_version !== incoming.contract_version;
}

// Exit-signal contract v1 — manner-of-death. A client may ONLY announce 'crashed' (its uncaught-
// exception handler fired) or 'clean_exit' (a confident lifecycle-end). 'silent' is server-inferred by
// ABSENCE and is NEVER accepted from a client. Honesty by construction: an unknown/uncertain value is
// rejected (-> null), so the device falls to server-inferred 'silent' rather than being coerced into a
// wrong category. detail is optional (crash message / lifecycle-hook name), sanitized + length-capped.
const CLIENT_EXIT_REASONS = ['crashed', 'clean_exit'];
function sanitizeExitReason(reason, detail) {
  if (!CLIENT_EXIT_REASONS.includes(reason)) return null;
  const d = (typeof detail === 'string' && detail.trim()) ? detail.trim().slice(0, 200) : null;
  return { reason, detail: d };
}

module.exports = { ackableHeartbeat, deriveLiveness, captureIdentity, identityChanged, sanitizeExitReason, CLIENT_EXIT_REASONS, HEALTHY_HEARTBEAT_MS, DEGRADED_RECONNECTS };
