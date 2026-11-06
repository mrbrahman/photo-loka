import { authenticatedFetch } from '../authn.mjs';

// Standard error: attempt to parse the server's JSON error body.
function throwError(res) {
  return res.json()
    .catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }))
    .then(body => { throw body; });
}

// getVapidPublicKey returns the server's VAPID public key (base64url), needed
// to call pushManager.subscribe({ applicationServerKey }).
export async function getVapidPublicKey() {
  let res = await authenticatedFetch('/api/push/vapidPublicKey');
  if (!res.ok) return throwError(res);
  let data = await res.json();
  return data.publicKey;
}

// registerDevice sends this browser's PushSubscription to the server so it can
// deliver pushes to it. subscription is a browser PushSubscription; we post its
// JSON form plus the user agent (so the user can tell devices apart later).
export async function registerDevice(subscription, userAgent) {
  let s = subscription.toJSON();
  let res = await authenticatedFetch('/api/push/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: s.endpoint,
      keys: { p256dh: s.keys.p256dh, auth: s.keys.auth },
      userAgent
    })
  });
  if (!res.ok) return throwError(res);
}

// unregisterDevice removes a device by its endpoint (explicit unsubscribe).
export async function unregisterDevice(endpoint) {
  let res = await authenticatedFetch('/api/push/devices', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint })
  });
  if (!res.ok) return throwError(res);
}

// sendTestPush asks the server to push a test notification to this device
// (identified by its subscription endpoint; it must belong to the current
// user). Resolves to the server's per-device result
// { device_id, status, error?, pruned? }. Throws the server's error body on
// failure (404 not registered, 502 transport failure carries { result }).
export async function sendTestPush(endpoint) {
  let res = await authenticatedFetch('/api/push/devices/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint })
  });
  if (!res.ok) return throwError(res);
  let data = await res.json();
  return data.result;
}
