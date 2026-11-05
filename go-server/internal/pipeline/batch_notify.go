package pipeline

import (
	"fmt"

	"photo-loka/internal/collections"
	"photo-loka/internal/push"
)

// Batch-end -> push notification glue.
//
// When a batch of new items finishes indexing, we raise one push notification
// per participating collection (per the agreed design: the pipeline is
// collection-agnostic, but the click-through search is collection-scoped, so a
// single blanket notification cannot be correctly scoped). Each notification's
// click-through opens that collection's search for items indexed on the batch's
// date.
//
// The two external dependencies (looking up a collection's name, sending the
// push) are indirected behind package vars so a unit test can drive the fan-out
// without a DB or real push service. Production wires them to the real
// collections.Get and push.NotifyAll in Init.

// collectionNameFn returns a display name for a collection id (best-effort: on
// error or unknown id the caller falls back to a generic label).
var collectionNameFn = func(id int64) (string, bool) {
	col, err := collections.Get(id)
	if err != nil || col == nil {
		return "", false
	}
	return col.CollectionName, true
}

// notifyFn sends one notification to all opted-in devices.
var notifyFn = push.NotifyAll

// handleBatchEnded is the batch watcher's onBatchEnded callback: fan out one
// notification per collection that received new items during the batch. The
// click-through query uses the batch's LOCAL end-date to match indexed_at,
// which is stored as datetime('now','localtime'); date(indexed_at) is therefore
// a local-date comparison.
func handleBatchEnded(b BatchEnded) {
	date := b.EndedAt.Local().Format("2006-01-02")
	// raw: is passed through to the FTS search as-is (see the README search
	// section); date(indexed_at) is a local-date match against the stored
	// localtime indexed_at. The double quotes are part of the raw: syntax and
	// survive JSON + the client's URL encoding intact.
	query := fmt.Sprintf(`raw:"date(indexed_at) = '%s'"`, date)

	for _, id := range b.CollectionIDs {
		name, ok := collectionNameFn(id)
		body := "New items were brought into your collection."
		if ok {
			body = fmt.Sprintf("New items in %s", name)
		}
		notifyFn(push.Payload{
			Title:        "New photos indexed",
			Body:         body,
			CollectionID: id,
			Query:        query,
		})
	}
}
