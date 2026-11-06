package push

import (
	"encoding/json"
	"errors"
	"net/http"
	"sync"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// Payload is the JSON body delivered to the service worker's push handler. The
// client renders title/body as the notification and, on click, builds a search
// route from collectionId + query (the search string, e.g. the raw: query that
// finds items indexed on the batch's date). The push package only transports
// this; the batch-end caller fills it in and the service worker interprets it.
//
// This shape is specific to the one notification we have today (new items
// indexed, click-through to a collection-scoped search). When other
// notification kinds arrive, revisit this (e.g. a type discriminator) as its
// own change rather than speculatively generalizing now.
type Payload struct {
	Title        string `json:"title"`
	Body         string `json:"body"`
	CollectionID int64  `json:"collectionId"`
	Query        string `json:"query"`
}

// maxSendConcurrency bounds how many pushes are in flight at once so a large
// device set cannot open an unbounded number of outbound connections.
const maxSendConcurrency = 8

// pushTTL is how long (seconds) the push service holds a message for a device
// it cannot reach right away (asleep, offline, Doze). After this the message is
// silently discarded -- the send still reported success. Our notifications are
// "new items were added" summaries that stay useful hours later, and the
// per-collection tag means a newer one replaces an older one, so a long TTL is
// safe. 30s (the original value) dropped notifications for phones idle at
// batch end.
const pushTTL = 24 * 60 * 60

// sendOptions builds the webpush options for a send (VAPID identity + TTL).
// Separate from sendOne so tests can check the options without a network call.
func sendOptions() *webpush.Options {
	return &webpush.Options{
		Subscriber:      vapidSubscriber,
		VAPIDPublicKey:  vapidPublicKey,
		VAPIDPrivateKey: vapidPrivateKey,
		TTL:             pushTTL,
	}
}

// sendOne delivers an already-marshaled payload to a single device and returns
// the push service's HTTP status (or an error for a transport failure). It is a
// package var so tests can substitute a fake without real network calls; the
// production implementation uses webpush.SendNotification.
var sendOne = func(payload []byte, d device) (status int, err error) {
	sub := &webpush.Subscription{
		Endpoint: d.Endpoint,
		Keys:     webpush.Keys{P256dh: d.P256dh, Auth: d.Auth},
	}
	resp, err := webpush.SendNotification(payload, sub, sendOptions())
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

// deliveryResult is the outcome of sending to one device. Status is the push
// service's HTTP status (0 on a transport error, with Err set). Pruned is true
// when the push service reported the subscription gone (404/410) and the device
// row was deleted.
type deliveryResult struct {
	DeviceID int64  `json:"device_id"`
	Status   int    `json:"status"`
	Err      string `json:"error,omitempty"`
	Pruned   bool   `json:"pruned,omitempty"`
}

// deliver sends one marshaled payload to every device concurrently (bounded),
// pruning any device whose push service reports it is gone (404/410). Transport
// errors and other non-2xx statuses are logged but not pruned (they may be
// transient). Returns one result per device, in the same order as devices, so
// a synchronous caller (the per-device test send) can report the outcome;
// NotifyAll ignores them.
func deliver(payload []byte, devices []device) []deliveryResult {
	results := make([]deliveryResult, len(devices))
	sem := make(chan struct{}, maxSendConcurrency)
	var wg sync.WaitGroup
	for i, d := range devices {
		i, d := i, d
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()

			// Each goroutine writes only its own index, so no lock is needed.
			res := deliveryResult{DeviceID: d.ID}
			defer func() { results[i] = res }()

			status, err := sendOne(payload, d)
			if err != nil {
				res.Err = err.Error()
				pushLogger().Error("push send failed", "endpoint", d.Endpoint, "error", err)
				return
			}
			res.Status = status
			switch {
			case status == http.StatusNotFound || status == http.StatusGone:
				// The subscription is dead: the browser unsubscribed or the push
				// service expired it. Prune so we stop sending to it.
				if err := deleteDeviceByEndpoint(d.Endpoint); err != nil {
					pushLogger().Error("pruning dead push device failed",
						"endpoint", d.Endpoint, "error", err)
				} else {
					res.Pruned = true
					pushLogger().Info("pruned dead push device", "endpoint", d.Endpoint)
				}
			case status >= 200 && status < 300:
				pushLogger().Debug("push delivered", "endpoint", d.Endpoint, "status", status)
			default:
				pushLogger().Warn("push service returned non-success",
					"endpoint", d.Endpoint, "status", status)
			}
		}()
	}
	wg.Wait()
	return results
}

// NotifyAll delivers a notification to every opted-in device. It is the
// package's primary entry point (the audience is all devices, per the
// shared-family model). It runs asynchronously: the caller (e.g. the pipeline
// batch-end path) is never blocked on network I/O. A nil/empty device set or a
// marshal error is a no-op (logged). Does nothing if Init has not produced a
// keypair.
func NotifyAll(p Payload) {
	if vapidPrivateKey == "" {
		pushLogger().Warn("NotifyAll called before VAPID keys were initialized")
		return
	}
	payload, err := json.Marshal(p)
	if err != nil {
		pushLogger().Error("marshaling push payload failed", "error", err)
		return
	}
	go func() {
		devices, err := allDevices()
		if err != nil {
			pushLogger().Error("loading devices for notify failed", "error", err)
			return
		}
		pushLogger().Info("notifying devices", "count", len(devices), "title", p.Title)
		if len(devices) == 0 {
			return
		}
		deliver(payload, devices)
	}()
}

// errDeviceNotFound is returned by sendTest when the endpoint is not registered
// to the calling user (unknown endpoint, or someone else's device).
var errDeviceNotFound = errors.New("device not registered for this user")

// errNotInitialized is returned by sendTest when Init has not produced a VAPID
// keypair, so no push can be signed.
var errNotInitialized = errors.New("web push is not initialized")

// testPayload is the notification sent when a user enables notifications on a
// device, so they immediately see one and know the whole path works. It has no
// collection, so the service worker uses its generic tag and a click just
// closes it.
func testPayload() Payload {
	return Payload{
		Title: "Photo-Loka notifications are on",
		Body:  "You'll be notified here when new items are added.",
	}
}

// sendTest synchronously sends the test notification to one device, identified
// by its endpoint, only if that device belongs to userID (a user can never push
// to someone else's device). Returns the push service's result for the device.
func sendTest(userID int64, endpoint string) (deliveryResult, error) {
	if vapidPrivateKey == "" {
		return deliveryResult{}, errNotInitialized
	}
	d, err := deviceForUser(userID, endpoint)
	if err != nil {
		return deliveryResult{}, err
	}
	if d == nil {
		return deliveryResult{}, errDeviceNotFound
	}
	payload, err := json.Marshal(testPayload())
	if err != nil {
		return deliveryResult{}, err
	}
	pushLogger().Info("sending test notification", "device_id", d.ID, "user_id", userID)
	return deliver(payload, []device{*d})[0], nil
}
