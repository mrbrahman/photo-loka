package pipeline

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// parseSSEData extracts the JSON payloads from "data: {...}" SSE frames in a
// response body.
func parseSSEData(t *testing.T, body string) []sseEvent {
	t.Helper()
	var out []sseEvent
	sc := bufio.NewScanner(strings.NewReader(body))
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var ev sseEvent
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev); err != nil {
			t.Fatalf("bad SSE data line %q: %v", line, err)
		}
		out = append(out, ev)
	}
	return out
}

// TestSSE_InitialSnapshotPerStage: on connect, the events handler emits one
// snapshot per stage (so a freshly-opened page renders current state without
// waiting for a transition), each self-identifying via its name. We cancel the
// request context right after connect so the handler returns after the initial
// snapshot.
func TestSSE_InitialSnapshotPerStage(t *testing.T) {
	p, _ := setP(t)
	gin.SetMode(gin.TestMode)

	// A request whose context is already cancelled: the handler writes the
	// initial snapshot, then the select sees clientGone and returns.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest("GET", "/api/admin/pipeline/events", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	events(c)

	got := parseSSEData(t, w.Body.String())
	seen := map[string]bool{}
	for _, ev := range got {
		seen[ev.Name] = true
	}
	for _, name := range allStages {
		if !seen[name] {
			t.Errorf("initial snapshot missing stage %q (got %d events)", name, len(got))
		}
	}
	// Content-Type is the SSE stream type.
	if ct := w.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}
	_ = p
}

// TestSSE_StreamsLiveQueueEvent: a live queue event (here a stage queue firing
// its event stream) is delivered on the merged subscriber channel, carrying the
// emitting stage's name and status. This proves the handler would forward live
// transitions verbatim (queue is the emitter; the pipeline only merges for
// discovery).
func TestSSE_StreamsLiveQueueEvent(t *testing.T) {
	p, fakes := fakePipeline(t, DefaultPipelineConfig())

	merged, stop := p.subscribeAllStages()
	defer stop()

	// Drive an event on one stage's queue: fireDrained emits a busy then a
	// drained snapshot to subscribers, each tagged with that stage's name via
	// the fake's Subscribe (the fake carries name set by the factory).
	fakes[StageGeoLookup].setBusy(2, 3)
	fakes[StageGeoLookup].emit()

	select {
	case ev := <-merged:
		if ev.Name != StageGeoLookup {
			t.Fatalf("event name = %q, want %q", ev.Name, StageGeoLookup)
		}
		if ev.Status.Active != 2 || ev.Status.Pending != 3 {
			t.Fatalf("event status active/pending = %d/%d, want 2/3", ev.Status.Active, ev.Status.Pending)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for a live queue event on the merged channel")
	}
}
