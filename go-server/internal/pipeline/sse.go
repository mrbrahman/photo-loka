package pipeline

import (
	"encoding/json"
	"io"
	"sync"

	"photo-loka/internal/queue"

	"github.com/gin-gonic/gin"
)

// SSE: the queue is the emitter. Each stage queue publishes its own events
// (counters, paused, max_concurrency, block_reason) carrying its opaque name;
// the SSE handler subscribes directly to every stage queue and forwards those
// events to the browser verbatim. The pipeline's only role here is DISCOVERY --
// handing the handler the set of stage queues to subscribe to. It does not
// relay, reshape, or enrich the events (notably it does NOT add the stage
// `enabled` flag; that is pipeline-level, changes only on config Apply, and the
// client refetches full status on load/Apply). This keeps the queue the single
// source of truth for live status, with SSE and the orchestrator as two
// independent subscribers of the same per-queue stream.

// subscribeAllStages subscribes to every stage queue's event stream and merges
// them onto a single channel for one SSE client. It returns the merged channel
// and a stop func the caller MUST invoke on disconnect to shut the fan-in
// goroutines down. Each Subscribe() call creates a fresh per-subscriber channel
// on the queue, so one client's subscriptions are independent of another's.
//
// This is discovery only: the events delivered are exactly what the queues emit
// (queue.Event, self-identifying via Name). The pipeline does not touch them.
func (p *Pipeline) subscribeAllStages() (<-chan queue.Event, func()) {
	merged := make(chan queue.Event, eventChanBuffer)
	stop := make(chan struct{})
	done := make(chan struct{})

	// Snapshot the stage queues. The stage set is fixed after construction, so
	// no lock is needed for the set itself; Subscribe is queue-internally safe.
	srcs := make([]<-chan queue.Event, 0, len(p.stages))
	for _, s := range p.stages {
		srcs = append(srcs, s.Queue.Subscribe())
	}

	// One fan-in goroutine per source, forwarding into merged until stop. A
	// slow/stuck client never blocks a queue: the queue's own emit is
	// non-blocking drop-oldest into each per-subscriber channel, and the merge
	// forward below also drops if merged is full.
	fanin := make(chan struct{}, len(srcs))
	for _, src := range srcs {
		src := src
		go func() {
			defer func() { fanin <- struct{}{} }()
			for {
				select {
				case <-stop:
					return
				case ev, ok := <-src:
					if !ok {
						return
					}
					select {
					case merged <- ev:
					case <-stop:
						return
					default:
						// merged full: drop. Each event is a full snapshot, so a
						// dropped intermediate is harmless -- the next one carries
						// the latest state.
					}
				}
			}
		}()
	}

	// Closer goroutine: once all fan-in goroutines have exited, close merged so
	// the handler's range loop terminates.
	go func() {
		for range srcs {
			<-fanin
		}
		close(done)
		close(merged)
	}()

	stopFn := func() {
		close(stop)
		<-done // wait for fan-in goroutines to drain and merged to close
	}
	return merged, stopFn
}

// eventChanBuffer is the merged-channel buffer for one SSE client. Small: events
// are full snapshots and forwarding is drop-oldest, so a slow client converges
// on the latest state without stalling any queue.
const eventChanBuffer = 32

// sseEvent is the JSON payload written to the browser for each queue event. It
// is the queue's own facts, flattened: the self-identifying name plus the
// Status snapshot (counters, is_paused, max_concurrency, block_reason). No
// pipeline overlay (enabled/label) -- the client refetches those on load/Apply.
type sseEvent struct {
	Name   string       `json:"name"`
	Status queue.Status `json:"status"`
}

// sseShutdown is closed once, when the server begins graceful shutdown
// (wired via http.Server.RegisterOnShutdown -> ShutdownSSE). Every open SSE
// handler selects on it and returns, so long-lived EventSource connections do
// not hold srv.Shutdown open until its deadline. An SSE stream is otherwise
// idle-but-open and never ends on its own, so without this the server's
// graceful shutdown blocks for the full timeout whenever a browser has the
// Indexer page open.
var sseShutdown = make(chan struct{})
var sseShutdownOnce sync.Once

// ShutdownSSE signals all open pipeline SSE handlers to close. Idempotent.
// Registered with the HTTP server via RegisterOnShutdown.
func ShutdownSSE() {
	sseShutdownOnce.Do(func() { close(sseShutdown) })
}

// events is the SSE endpoint for live pipeline status.
// GET /api/admin/pipeline/events
//
// Authenticated via the admin group: EventSource cannot send an Authorization
// header, but AuthMiddleware falls back to the refreshToken cookie (sent
// automatically on same-origin requests) and AdminMiddleware reads the role it
// sets. Silent when idle: queues emit only on dispatch-cycle transitions, so an
// idle pipeline produces no traffic. On connect we send one snapshot per stage
// so a freshly-opened page shows current state immediately.
func events(c *gin.Context) {
	if P == nil {
		notReady(c)
		return
	}

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Writer.Flush()

	merged, stop := P.subscribeAllStages()
	defer stop()

	// Initial snapshot: one event per stage so the client renders current state
	// on connect without waiting for the next transition.
	for name := range P.stages {
		st := P.stages[name].Queue.GetStatus()
		if !writeSSE(c.Writer, sseEvent{Name: name, Status: st}) {
			return
		}
	}
	c.Writer.Flush()

	clientGone := c.Request.Context().Done()
	for {
		select {
		case <-sseShutdown:
			// Server is shutting down: return so the connection goes idle and
			// srv.Shutdown can complete without waiting for the deadline.
			return
		case <-clientGone:
			return
		case ev, ok := <-merged:
			if !ok {
				return
			}
			if !writeSSE(c.Writer, sseEvent{Name: ev.Name, Status: ev.Status}) {
				return
			}
			c.Writer.Flush()
		}
	}
}

// writeSSE marshals one event and writes it as an SSE "data:" frame. Returns
// false if the write failed (client gone), so the caller stops the stream.
func writeSSE(w io.Writer, ev sseEvent) bool {
	payload, err := json.Marshal(ev)
	if err != nil {
		return false
	}
	if _, err := io.WriteString(w, "data: "); err != nil {
		return false
	}
	if _, err := w.Write(payload); err != nil {
		return false
	}
	if _, err := io.WriteString(w, "\n\n"); err != nil {
		return false
	}
	return true
}
