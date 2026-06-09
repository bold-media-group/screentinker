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

module.exports = { stripDeviceSecrets };
