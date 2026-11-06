package push

import (
	"net/http"
	"path/filepath"
	"testing"

	"photo-loka/internal/database"
)

// openTestDB opens a fresh migrated temp DB (so push_vapid_keys / push_devices
// exist) and resets the package VAPID vars for isolation.
func openTestDB(t *testing.T) {
	t.Helper()
	dbFile := filepath.Join(t.TempDir(), "test.sqlite")
	if err := database.Open(dbFile); err != nil {
		t.Fatalf("opening db / running migrations: %v", err)
	}
	t.Cleanup(func() {
		database.Close()
		vapidPublicKey, vapidPrivateKey = "", ""
	})
	vapidPublicKey, vapidPrivateKey = "", ""
}

// TestInit_GeneratesThenReusesKeys: first Init generates and persists a keypair;
// a second Init (simulating a restart, package vars cleared) reuses the SAME
// stored keypair rather than regenerating.
func TestInit_GeneratesThenReusesKeys(t *testing.T) {
	openTestDB(t)

	if err := Init(); err != nil {
		t.Fatalf("first Init: %v", err)
	}
	pub1, priv1 := vapidPublicKey, vapidPrivateKey
	if pub1 == "" || priv1 == "" {
		t.Fatal("Init did not populate VAPID keys")
	}

	// Simulate a restart: clear the in-memory keys, Init again. The DB row
	// persists, so the keys must come back identical.
	vapidPublicKey, vapidPrivateKey = "", ""
	if err := Init(); err != nil {
		t.Fatalf("second Init: %v", err)
	}
	if vapidPublicKey != pub1 || vapidPrivateKey != priv1 {
		t.Fatalf("Init regenerated keys on reuse: got (%q,%q), want (%q,%q)",
			vapidPublicKey, vapidPrivateKey, pub1, priv1)
	}

	// Exactly one keypair row.
	var n int
	if err := database.DB.QueryRow(`SELECT COUNT(*) FROM push_vapid_keys`).Scan(&n); err != nil {
		t.Fatalf("count vapid rows: %v", err)
	}
	if n != 1 {
		t.Fatalf("want exactly 1 vapid keypair row, got %d", n)
	}

	if PublicKey() != pub1 {
		t.Fatalf("PublicKey() = %q, want %q", PublicKey(), pub1)
	}
}

// TestUpsertDevice_DedupesByEndpoint: registering the same endpoint twice
// updates in place (one row), and a different endpoint adds a second row.
func TestUpsertDevice_DedupesByEndpoint(t *testing.T) {
	openTestDB(t)

	if err := upsertDevice(1, "https://push/ep1", "p1", "a1", "UA1"); err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	// Same endpoint, new keys/owner -> updates, no new row.
	if err := upsertDevice(2, "https://push/ep1", "p1b", "a1b", "UA1b"); err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	if err := upsertDevice(1, "https://push/ep2", "p2", "a2", "UA2"); err != nil {
		t.Fatalf("third upsert: %v", err)
	}

	devices, err := allDevices()
	if err != nil {
		t.Fatalf("allDevices: %v", err)
	}
	if len(devices) != 2 {
		t.Fatalf("want 2 devices, got %d", len(devices))
	}
	// ep1 must reflect the update (owner 2, keys p1b/a1b).
	var ep1 *device
	for i := range devices {
		if devices[i].Endpoint == "https://push/ep1" {
			ep1 = &devices[i]
		}
	}
	if ep1 == nil {
		t.Fatal("ep1 missing")
	}
	if ep1.UserID != 2 || ep1.P256dh != "p1b" || ep1.Auth != "a1b" {
		t.Fatalf("ep1 not updated in place: %+v", *ep1)
	}
}

// TestDeliver_PrunesGoneDevices: a device whose push service returns 410 (or
// 404) is deleted; a 201 device is kept; a transport error is kept (may be
// transient).
func TestDeliver_PrunesGoneDevices(t *testing.T) {
	openTestDB(t)

	mustUpsert := func(ep string) {
		if err := upsertDevice(1, ep, "p", "a", "UA"); err != nil {
			t.Fatalf("upsert %s: %v", ep, err)
		}
	}
	mustUpsert("https://push/gone410")
	mustUpsert("https://push/gone404")
	mustUpsert("https://push/ok")
	mustUpsert("https://push/err")

	// Swap the send seam: status keyed off the endpoint.
	orig := sendOne
	t.Cleanup(func() { sendOne = orig })
	sendOne = func(payload []byte, d device) (int, error) {
		switch d.Endpoint {
		case "https://push/gone410":
			return http.StatusGone, nil
		case "https://push/gone404":
			return http.StatusNotFound, nil
		case "https://push/ok":
			return http.StatusCreated, nil
		default:
			return 0, errTransport
		}
	}

	devices, err := allDevices()
	if err != nil {
		t.Fatalf("allDevices: %v", err)
	}
	deliver([]byte(`{"title":"t"}`), devices)

	remaining, err := allDevices()
	if err != nil {
		t.Fatalf("allDevices after deliver: %v", err)
	}
	got := map[string]bool{}
	for _, d := range remaining {
		got[d.Endpoint] = true
	}
	if got["https://push/gone410"] || got["https://push/gone404"] {
		t.Fatalf("gone devices were not pruned: %v", got)
	}
	if !got["https://push/ok"] {
		t.Fatal("ok device was wrongly pruned")
	}
	if !got["https://push/err"] {
		t.Fatal("transport-error device was wrongly pruned (should be kept)")
	}
}

type transportErr struct{}

func (transportErr) Error() string { return "transport failure" }

var errTransport = transportErr{}

// TestSendTest_OwnershipAndResult: the test send only reaches the caller's own
// device, reports the push service's status, and refuses someone else's device.
func TestSendTest_OwnershipAndResult(t *testing.T) {
	openTestDB(t)
	vapidPrivateKey = "test-key" // sendOne is faked; just needs to be non-empty

	if err := upsertDevice(1, "https://push/mine", "p", "a", "UA"); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := upsertDevice(2, "https://push/theirs", "p", "a", "UA"); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	var sentTo []string
	orig := sendOne
	t.Cleanup(func() { sendOne = orig })
	sendOne = func(payload []byte, d device) (int, error) {
		sentTo = append(sentTo, d.Endpoint)
		return http.StatusCreated, nil
	}

	res, err := sendTest(1, "https://push/mine")
	if err != nil {
		t.Fatalf("sendTest own device: %v", err)
	}
	if res.Status != http.StatusCreated || res.Err != "" || res.Pruned {
		t.Fatalf("unexpected result: %+v", res)
	}

	// User 1 must not be able to push to user 2's device.
	if _, err := sendTest(1, "https://push/theirs"); err != errDeviceNotFound {
		t.Fatalf("want errDeviceNotFound for someone else's device, got %v", err)
	}
	// Unknown endpoint likewise.
	if _, err := sendTest(1, "https://push/unknown"); err != errDeviceNotFound {
		t.Fatalf("want errDeviceNotFound for unknown endpoint, got %v", err)
	}

	if len(sentTo) != 1 || sentTo[0] != "https://push/mine" {
		t.Fatalf("should have sent only to the caller's device, sent to %v", sentTo)
	}
}

// TestSendTest_PrunedAndErrors: a gone subscription is reported as pruned (and
// removed), a transport error is reported in the result, and an uninitialized
// server refuses.
func TestSendTest_PrunedAndErrors(t *testing.T) {
	openTestDB(t)

	// Not initialized: no VAPID key.
	if _, err := sendTest(1, "https://push/x"); err != errNotInitialized {
		t.Fatalf("want errNotInitialized, got %v", err)
	}
	vapidPrivateKey = "test-key"

	if err := upsertDevice(1, "https://push/gone", "p", "a", "UA"); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := upsertDevice(1, "https://push/err", "p", "a", "UA"); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	orig := sendOne
	t.Cleanup(func() { sendOne = orig })
	sendOne = func(payload []byte, d device) (int, error) {
		if d.Endpoint == "https://push/gone" {
			return http.StatusGone, nil
		}
		return 0, errTransport
	}

	res, err := sendTest(1, "https://push/gone")
	if err != nil {
		t.Fatalf("sendTest gone: %v", err)
	}
	if !res.Pruned || res.Status != http.StatusGone {
		t.Fatalf("want pruned 410 result, got %+v", res)
	}
	if d, _ := deviceForUser(1, "https://push/gone"); d != nil {
		t.Fatal("gone device should have been removed")
	}

	res, err = sendTest(1, "https://push/err")
	if err != nil {
		t.Fatalf("sendTest err: %v", err)
	}
	if res.Err == "" || res.Status != 0 {
		t.Fatalf("want transport error in result, got %+v", res)
	}
}

// TestDeleteDeviceForUser_OnlyOwnDevice: unsubscribing removes the caller's own
// device but leaves another user's device untouched (and does not error).
func TestDeleteDeviceForUser_OnlyOwnDevice(t *testing.T) {
	openTestDB(t)

	if err := upsertDevice(1, "https://push/mine", "p", "a", "UA"); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := upsertDevice(2, "https://push/theirs", "p", "a", "UA"); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	// User 1 tries to delete user 2's device: no-op, no error.
	if err := deleteDeviceForUser(1, "https://push/theirs"); err != nil {
		t.Fatalf("delete other user's device: %v", err)
	}
	if d, _ := deviceForUser(2, "https://push/theirs"); d == nil {
		t.Fatal("another user's device was deleted")
	}

	// User 1 deletes their own device.
	if err := deleteDeviceForUser(1, "https://push/mine"); err != nil {
		t.Fatalf("delete own device: %v", err)
	}
	if d, _ := deviceForUser(1, "https://push/mine"); d != nil {
		t.Fatal("own device was not deleted")
	}
}

// TestSendOptions_TTLAndIdentity: sends carry the long TTL (so a sleeping or
// offline device still gets the notification later) and the server's VAPID
// identity.
func TestSendOptions_TTLAndIdentity(t *testing.T) {
	vapidPublicKey, vapidPrivateKey = "pub", "priv"
	t.Cleanup(func() { vapidPublicKey, vapidPrivateKey = "", "" })

	o := sendOptions()
	if o.TTL != 86400 {
		t.Errorf("TTL = %d, want 86400 (24h)", o.TTL)
	}
	if o.VAPIDPublicKey != "pub" || o.VAPIDPrivateKey != "priv" || o.Subscriber != vapidSubscriber {
		t.Errorf("unexpected VAPID identity in options: %+v", o)
	}
}
