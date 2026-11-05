package pipeline

import (
	"testing"
	"time"

	"photo-loka/internal/push"
)

// TestHandleBatchEnded_FansOutPerCollection: one notification per collection id,
// each carrying that collection's id, the batch's local end-date query, and a
// body with the collection name (or a generic fallback when the name lookup
// fails).
func TestHandleBatchEnded_FansOutPerCollection(t *testing.T) {
	// Stub the collection-name lookup: 1 -> "Family", 2 unknown.
	origName := collectionNameFn
	collectionNameFn = func(id int64) (string, bool) {
		if id == 1 {
			return "Family", true
		}
		return "", false
	}
	t.Cleanup(func() { collectionNameFn = origName })

	// Capture notifications instead of sending.
	var got []push.Payload
	origNotify := notifyFn
	notifyFn = func(p push.Payload) { got = append(got, p) }
	t.Cleanup(func() { notifyFn = origNotify })

	// A batch that ended at a known local time.
	ended := time.Date(2026, 11, 4, 23, 30, 0, 0, time.Local)
	handleBatchEnded(BatchEnded{
		StartedAt:     ended.Add(-5 * time.Minute),
		EndedAt:       ended,
		CollectionIDs: []int64{1, 2},
	})

	if len(got) != 2 {
		t.Fatalf("want 2 notifications, got %d", len(got))
	}

	wantQuery := `raw:"date(indexed_at) = '2026-11-04'"`
	for _, p := range got {
		if p.Query != wantQuery {
			t.Errorf("query = %q, want %q", p.Query, wantQuery)
		}
		if p.Title == "" {
			t.Errorf("title should be set")
		}
	}

	// Collection 1 carries its id + name in the body.
	if got[0].CollectionID != 1 || got[0].Body != "New items in Family" {
		t.Errorf("collection 1 payload wrong: %+v", got[0])
	}
	// Collection 2 (unknown name) falls back to the generic body.
	if got[1].CollectionID != 2 || got[1].Body != "New items were brought into your collection." {
		t.Errorf("collection 2 payload wrong: %+v", got[1])
	}
}

// TestHandleBatchEnded_NoCollections: a batch with no collection ids (shouldn't
// happen for a new-items batch, but defensively) sends nothing.
func TestHandleBatchEnded_NoCollections(t *testing.T) {
	var got []push.Payload
	origNotify := notifyFn
	notifyFn = func(p push.Payload) { got = append(got, p) }
	t.Cleanup(func() { notifyFn = origNotify })

	handleBatchEnded(BatchEnded{EndedAt: time.Now()})
	if len(got) != 0 {
		t.Fatalf("want 0 notifications, got %d", len(got))
	}
}
