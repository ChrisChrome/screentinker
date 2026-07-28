'use strict';

// Security: never return a device's WebSocket auth secret to API/dashboard
// clients. `device_token` is the credential the device proves with (validated
// via crypto.timingSafeEqual on the /device socket); leaking it to any
// workspace user enables device impersonation. Strip it from every device row
// before it leaves the server.
function stripDeviceSecrets(d) {
  if (!d || typeof d !== 'object') return d;
  delete d.device_token;
  return d;
}

// List responses additionally drop `settings_pin`.
//
// The PIN unlocks the player's on-device settings menu (2x Back), i.e. physical control of
// the panel. The dashboard genuinely needs it — but only on ONE screen, the device detail
// page, which fetches a single device via GET /api/devices/:id. The collection endpoint was
// handing out the PIN for EVERY device in the workspace on every load, to every member,
// with no consumer for it. Same data, far wider blast radius, for nothing.
//
// So: detail keeps it (the feature is unchanged), the list does not. If a future list view
// needs the PIN, fetch the device rather than widening this.
function stripDeviceSecretsForList(d) {
  const row = stripDeviceSecrets(d);
  if (row && typeof row === 'object') delete row.settings_pin;
  return row;
}

module.exports = { stripDeviceSecrets, stripDeviceSecretsForList };
