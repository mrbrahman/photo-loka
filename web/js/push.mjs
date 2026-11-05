// Browser Web Push plumbing: permission, subscription, and the server
// handshake. Kept separate from the UI component so the app shell only deals in
// high-level state ('subscribed' / 'unsubscribed' / 'denied' / 'unsupported')
// and enable/disable actions.
//
// The service worker's push / notificationclick handlers live in sw.mjs (added
// separately). A subscription created here will start rendering notifications
// once those handlers exist; until then the subscription is registered server
// side but a delivered push is simply not displayed.

import { getVapidPublicKey, registerDevice, unregisterDevice } from './api/push-api.mjs';

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
