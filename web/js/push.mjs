// Browser Web Push plumbing: permission, subscription, and the server
// handshake. Kept separate from the UI component so the app shell only deals in
// high-level state ('subscribed' / 'unsubscribed' / 'denied' / 'unsupported')
// and enable/disable actions.
//
// The service worker's push / notificationclick handlers live in sw.mjs (added
// separately). A subscription created here will start rendering notifications
// once those handlers exist; until then the subscription is registered server
// side but a delivered push is simply not displayed.

import { getVapidPublicKey, registerDevice, unregisterDevice, sendTestPush } from './api/push-api.mjs';

// isPushSupported reports whether this browser can do Web Push at all.
export function isPushSupported() {
  return 'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
}

// getSubscriptionState returns the current high-level push state for the UI:
//   'unsupported' - the browser lacks Web Push
//   'denied'      - the user blocked notifications (cannot re-prompt)
//   'subscribed'  - permission granted AND an active push subscription exists
//   'unsubscribed'- permission not blocked but no active subscription
export async function getSubscriptionState(registration) {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (!registration) return 'unsubscribed';
  const sub = await registration.pushManager.getSubscription();
  return sub ? 'subscribed' : 'unsubscribed';
}

// enablePush requests permission (if needed), subscribes via the push manager
// using the server VAPID public key, and registers the subscription server
// side. Returns the resulting state ('subscribed' on success, 'denied' if the
// user blocked the prompt). Throws on an unexpected error (network, etc.).
export async function enablePush(registration) {
  if (!isPushSupported()) return 'unsupported';
  if (!registration) throw new Error('no service worker registration');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return permission === 'denied' ? 'denied' : 'unsubscribed';
  }

  // Reuse an existing subscription if present (idempotent re-enable).
  let sub = await registration.pushManager.getSubscription();
  if (!sub) {
    const publicKey = await getVapidPublicKey();
    sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
  }

  await registerDevice(sub, navigator.userAgent);
  return 'subscribed';
}

// disablePush unregisters the subscription server side and unsubscribes locally.
// Returns 'unsubscribed'. Safe to call when not subscribed (no-op).
export async function disablePush(registration) {
  if (!registration) return 'unsubscribed';
  const sub = await registration.pushManager.getSubscription();
  if (sub) {
    // Remove server side first so we stop targeting a soon-to-be-dead endpoint,
    // then drop the local subscription.
    try {
      await unregisterDevice(sub.endpoint);
    } finally {
      await sub.unsubscribe();
    }
  }
  return 'unsubscribed';
}

// RECEIPT_TIMEOUT_MS is how long testPush waits for the service worker to
// report that the test push arrived on this device. Push services normally
// deliver within a few seconds to an awake device.
const RECEIPT_TIMEOUT_MS = 20000;

// testPush asks the server to send a test notification to this device and
// waits for the service worker to confirm it arrived. Resolves to one of:
//   { outcome: 'received' }            - arrived and the notification was shown
//   { outcome: 'shown-failed', error } - arrived but showNotification failed
//   { outcome: 'not-received' }        - server/push service accepted it, but it
//                                        did not arrive here within the timeout
//   { outcome: 'expired' }             - push service reported the subscription
//                                        gone; the server removed this device
//   { outcome: 'rejected', status }    - push service returned another non-2xx
//   { outcome: 'error', message }      - could not send (server/network error)
// The receipt listener is attached BEFORE sending so a fast delivery cannot
// arrive before we start listening.
export async function testPush(registration) {
  const sub = registration && await registration.pushManager.getSubscription();
  if (!sub) return { outcome: 'error', message: 'no push subscription on this device' };

  const receipt = waitForReceipt(RECEIPT_TIMEOUT_MS);
  let result;
  try {
    result = await sendTestPush(sub.endpoint);
  } catch (err) {
    receipt.cancel();
    return { outcome: 'error', message: err?.error?.message || err?.result?.error || 'send failed' };
  }

  if (result.pruned) { receipt.cancel(); return { outcome: 'expired' }; }
  if (result.status < 200 || result.status >= 300) {
    receipt.cancel();
    return { outcome: 'rejected', status: result.status };
  }

  const r = await receipt.promise;
  if (!r) return { outcome: 'not-received' };
  if (r.shown === false) return { outcome: 'shown-failed', error: r.error };
  return { outcome: 'received' };
}

// waitForReceipt resolves with the service worker's push-received message
// ({ shown, error? }), or null after timeoutMs. cancel() stops waiting early.
function waitForReceipt(timeoutMs) {
  let onMessage, timer, settle;
  const promise = new Promise(resolve => {
    settle = (v) => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('message', onMessage);
      resolve(v);
    };
    onMessage = (e) => {
      if (e.data?.type === 'push-received') settle(e.data);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    timer = setTimeout(() => settle(null), timeoutMs);
  });
  return { promise, cancel: () => settle(null) };
}

// urlBase64ToUint8Array converts a base64url VAPID public key (as served by the
// server) to the Uint8Array that pushManager.subscribe expects for
// applicationServerKey. Standard Web Push boilerplate.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}
