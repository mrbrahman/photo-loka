package push

import (
	"encoding/json"
	"net/http"
	"sync"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// Payload is the JSON body delivered to the service worker's push handler. The
// client renders title/body as the notification and navigates to url on click.
// Bit 3 populates these (message text + the date(indexed_at) click-through
// URL); the push package only transports it.
type Payload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
}

// maxSendConcurrency bounds how many pushes are in flight at once so a large
// device set cannot open an unbounded number of outbound connections.
const maxSendConcurrency = 8

// sendOne delivers an already-marshaled payload to a single device and returns
// the push service's HTTP status (or an error for a transport failure). It is a
// package var so tests can substitute a fake without real network calls; the
// production implementation uses webpush.SendNotification.
var sendOne = func(payload []byte, d device) (status int, err error) {
	sub := &webpush.Subscription{
		Endpoint: d.Endpoint,
		Keys:     webpush.Keys{P256dh: d.P256dh, Auth: d.Auth},
	}
	resp, err := webpush.SendNotification(payload, sub, &webpush.Options{
		Subscriber:      vapidSubscriber,
		VAPIDPublicKey:  vapidPublicKey,
		VAPIDPrivateKey: vapidPrivateKey,
		TTL:             30,
	})
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

// deliver sends one marshaled payload to every device concurrently (bounded),
// pruning any device whose push service reports it is gone (404/410). Transport
// errors and other non-2xx statuses are logged but not pruned (they may be
// transient). It is the shared core of NotifyAll and the test-friendly entry.
func deliver(payload []byte, devices []device) {
	sem := make(chan struct{}, maxSendConcurrency)
	var wg sync.WaitGroup
	for _, d := range devices {
		d := d
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()

			status, err := sendOne(payload, d)
			if err != nil {
				pushLogger().Error("push send failed", "endpoint", d.Endpoint, "error", err)
				return
			}
			switch {
			case status == http.StatusNotFound || status == http.StatusGone:
				// The subscription is dead: the browser unsubscribed or the push
				// service expired it. Prune so we stop sending to it.
				if err := deleteDeviceByEndpoint(d.Endpoint); err != nil {
					pushLogger().Error("pruning dead push device failed",
						"endpoint", d.Endpoint, "error", err)
				} else {
					pushLogger().Info("pruned dead push device", "endpoint", d.Endpoint)
				}
			case status >= 200 && status < 300:
				// Delivered.
			default:
				pushLogger().Warn("push service returned non-success",
					"endpoint", d.Endpoint, "status", status)
			}
		}()
	}
	wg.Wait()
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
		if len(devices) == 0 {
			return
		}
		deliver(payload, devices)
	}()
}
