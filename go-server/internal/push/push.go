// Package push implements Web Push (RFC 8030/8291/8292) notifications: a
// server-managed VAPID identity, the set of opted-in devices, and a sender that
// delivers encrypted payloads to each device's push service.
//
// Per the project's architecture rules this is a package-level singleton, not a
// boilerplate class: Init() loads (or first-time generates) the VAPID keypair
// into package vars once at startup, and the rest of the API is package
// functions over database.DB. There is exactly one push identity and one device
// table for the life of the process.
package push

import (
	"log/slog"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// vapidSubscriber is the contact placed in the VAPID JWT's "sub" claim so a
// push service operator can reach the server operator. Push services require a
// mailto: or https: value but do not verify it. Photo-Loka has no email config
// yet (see the self-update TODO in the README); this is a placeholder. Promote
// to a configurable value when email config lands.
const vapidSubscriber = "mailto:admin@photo-loka.local"

// VAPID keypair, loaded once by Init. The public key is handed to browsers at
// subscribe time; the private key signs each push and never leaves the process.
var (
	vapidPublicKey  string
	vapidPrivateKey string
)

func pushLogger() *slog.Logger { return slog.Default().With("component", "push") }

// Init loads the server's VAPID keypair, generating and persisting it on first
// run. Must be called once at startup after the database is open (the keypair
// lives in the push_vapid_keys table). Idempotent in effect: a subsequent run
// reuses the stored keypair.
func Init() error {
	pub, priv, err := loadVAPIDKeys()
	if err != nil {
		return err
	}
	if pub == "" || priv == "" {
		// First run: generate a keypair and persist it. Regenerating later would
		// invalidate every stored device, so we only ever generate when none
		// exists.
		priv, pub, err = webpush.GenerateVAPIDKeys()
		if err != nil {
			return err
		}
		if err := saveVAPIDKeys(pub, priv); err != nil {
			return err
		}
		pushLogger().Info("generated new VAPID keypair")
	}
	vapidPublicKey = pub
	vapidPrivateKey = priv
	return nil
}

// PublicKey returns the server's VAPID public key (base64url). Empty until Init
// has run. Served to browsers so they can subscribe.
func PublicKey() string { return vapidPublicKey }
