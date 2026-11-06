package push

import (
	"database/sql"
	"fmt"

	"photo-loka/internal/database"
)

// device is one row of push_devices: a browser/device that can receive pushes.
// endpoint is the push service URL (natural key); p256dh/auth are the client
// encryption keys (RFC 8291).
type device struct {
	ID       int64
	UserID   int64
	Endpoint string
	P256dh   string
	Auth     string
}

// loadVAPIDKeys reads the single push_vapid_keys row. Returns ("", "", nil)
// when no keypair has been generated yet (so Init can generate one).
func loadVAPIDKeys() (pub, priv string, err error) {
	row := database.DB.QueryRow(
		`SELECT public_key, private_key FROM push_vapid_keys WHERE id = 1`,
	)
	switch err := row.Scan(&pub, &priv); err {
	case nil:
		return pub, priv, nil
	case sql.ErrNoRows:
		return "", "", nil
	default:
		return "", "", fmt.Errorf("reading vapid keys: %w", err)
	}
}

// saveVAPIDKeys inserts the single keypair row. It uses INSERT (not upsert): a
// keypair is written exactly once, on first run, and never overwritten (the
// CHECK (id = 1) plus this insert-once discipline keep the identity stable).
func saveVAPIDKeys(pub, priv string) error {
	if _, err := database.DB.Exec(
		`INSERT INTO push_vapid_keys (id, public_key, private_key) VALUES (1, ?, ?)`,
		pub, priv,
	); err != nil {
		return fmt.Errorf("saving vapid keys: %w", err)
	}
	return nil
}

// upsertDevice registers (or refreshes) a device for a user. endpoint is unique,
// so re-subscribing the same browser updates its keys/owner rather than
// inserting a duplicate, and refreshes last_used_at.
func upsertDevice(userID int64, endpoint, p256dh, auth, userAgent string) error {
	if _, err := database.DB.Exec(
		`INSERT INTO push_devices (user_id, endpoint, p256dh, auth, user_agent, last_used_at)
		 VALUES (?, ?, ?, ?, ?, datetime('now'))
		 ON CONFLICT(endpoint) DO UPDATE SET
		   user_id = excluded.user_id,
		   p256dh = excluded.p256dh,
		   auth = excluded.auth,
		   user_agent = excluded.user_agent,
		   last_used_at = datetime('now')`,
		userID, endpoint, p256dh, auth, userAgent,
	); err != nil {
		return fmt.Errorf("upserting push device: %w", err)
	}
	return nil
}

// deleteDeviceByEndpoint removes a device by its endpoint regardless of owner.
// Used only for pruning a dead endpoint (404/410 Gone from the push service);
// the client-facing unsubscribe uses deleteDeviceForUser.
func deleteDeviceByEndpoint(endpoint string) error {
	if _, err := database.DB.Exec(
		`DELETE FROM push_devices WHERE endpoint = ?`, endpoint,
	); err != nil {
		return fmt.Errorf("deleting push device: %w", err)
	}
	return nil
}

// deviceForUser returns the device with the given endpoint only if it belongs
// to userID; (nil, nil) when there is no such device for that user. Used by the
// test send so a user can only push to their own devices.
func deviceForUser(userID int64, endpoint string) (*device, error) {
	var d device
	err := database.DB.QueryRow(
		`SELECT id, user_id, endpoint, p256dh, auth FROM push_devices
		 WHERE endpoint = ? AND user_id = ?`,
		endpoint, userID,
	).Scan(&d.ID, &d.UserID, &d.Endpoint, &d.P256dh, &d.Auth)
	switch err {
	case nil:
		return &d, nil
	case sql.ErrNoRows:
		return nil, nil
	default:
		return nil, fmt.Errorf("loading push device: %w", err)
	}
}

// deleteDeviceForUser removes a device by its endpoint only if it belongs to
// userID. Used by the explicit unsubscribe endpoint so a user can only remove
// their own devices. Deleting an unknown (or someone else's) endpoint is a
// silent no-op, keeping unsubscribe idempotent.
func deleteDeviceForUser(userID int64, endpoint string) error {
	if _, err := database.DB.Exec(
		`DELETE FROM push_devices WHERE endpoint = ? AND user_id = ?`, endpoint, userID,
	); err != nil {
		return fmt.Errorf("deleting push device: %w", err)
	}
	return nil
}

// allDevices returns every opted-in device (the notification audience is all
// devices, per the shared-family model). Order is by id for determinism.
func allDevices() ([]device, error) {
	rows, err := database.DB.Query(
		`SELECT id, user_id, endpoint, p256dh, auth FROM push_devices ORDER BY id`,
	)
	if err != nil {
		return nil, fmt.Errorf("loading push devices: %w", err)
	}
	defer rows.Close()

	var out []device
	for rows.Next() {
		var d device
		if err := rows.Scan(&d.ID, &d.UserID, &d.Endpoint, &d.P256dh, &d.Auth); err != nil {
			return nil, fmt.Errorf("scanning push device: %w", err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating push devices: %w", err)
	}
	return out, nil
}
