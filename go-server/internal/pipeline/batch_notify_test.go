package pipeline

import (
	"testing"
	"time"

	"photo-loka/internal/push"
)

// TestHandleBatchEnded_FansOutPerCollection: one notification per collection id,
// each carrying that collection's id, the batch's local end-date query, a title
// with the collection name (or a generic fallback), and a body with today's
// indexed count (singular/plural).
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

	// Stub the day-count: collection 1 -> 5 items, collection 2 -> 1 item.
	origCount := countIndexedTodayFn
	countIndexedTodayFn = func(id int64, date string) (int, error) {
		if id == 1 {
			return 5, nil
		}
		return 1, nil
	}
	t.Cleanup(func() { countIndexedTodayFn = origCount })

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
	}

	// Collection 1: named title + plural body.
	if got[0].CollectionID != 1 ||
		got[0].Title != "Family - new items added!" ||
		got[0].Body != "5 items indexed today" {
		t.Errorf("collection 1 payload wrong: %+v", got[0])
	}
	// Collection 2: fallback title + singular body.
	if got[1].CollectionID != 2 ||
		got[1].Title != "New items added!" ||
		got[1].Body != "1 item indexed today" {
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
