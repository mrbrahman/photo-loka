-- Web Push (RFC 8030/8291/8292) support: a server-managed VAPID identity and
-- the set of browser/devices that have opted in to receive push notifications.

-- push_vapid_keys: the server's single ECDSA P-256 VAPID keypair, auto-generated
-- once on first use and reused forever. This is NOT user configuration (it is
-- never edited by a human and the private key must never be exposed), so it
-- lives in its own table rather than in runtime_config. The public key is
-- served to browsers at subscribe time; the private key signs each push and
-- never leaves the server. The CHECK (id = 1) makes this a single-row table so
-- a second keypair can never be inserted by accident (rotating the keypair
-- would invalidate every stored device, so it must be deliberate).
CREATE TABLE push_vapid_keys (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  public_key  TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- push_devices: one row per browser/device that has opted in. This is the push
-- TRANSPORT (where and how to deliver), deliberately separate from any future
-- notification-type preferences (a later push_preferences table) so a device
-- subscribes once and new notification types reuse the same device. endpoint is
-- the push service URL and is the natural key: re-subscribing the same browser
-- upserts rather than duplicating. p256dh/auth are the client keys used to
-- encrypt the payload for that device (RFC 8291). user_agent is stored so a
-- user can tell their devices apart later. A device is pruned by the sender
-- when its push service returns 404/410 Gone.
CREATE TABLE push_devices (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX idx_push_devices_user ON push_devices(user_id);
