package pipeline

import (
	"fmt"

	"photo-loka/internal/collections"
	"photo-loka/internal/database"
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
// The external dependencies (collection name lookup, today's indexed-count, and
// sending the push) are indirected behind package vars so a unit test can drive
// the fan-out without a DB or real push service. Production wires them to the
// real collections.Get / DB query / push.NotifyAll.

// collectionNameFn returns a display name for a collection id (best-effort: on
// error or unknown id the caller falls back to a generic label).
var collectionNameFn = func(id int64) (string, bool) {
	col, err := collections.Get(id)
	if err != nil || col == nil {
		return "", false
	}
	return col.CollectionName, true
}

// countIndexedTodayFn returns how many items in the collection were indexed on
// the given local date. It MUST match the notification's click-through query
// (date(indexed_at) = date) and the default search visibility filters
// (non-trashed, non-private), so the number shown and the set the click opens
// agree. We count the whole day (not just this batch) precisely because the
// click opens the whole day: a later batch supersedes the earlier notification
// (per-collection tag coalescing), so the user always sees today's running
// total, consistent with what a click reveals.
var countIndexedTodayFn = func(collectionID int64, date string) (int, error) {
	var n int
	err := database.DB.QueryRow(
		`SELECT count(*) FROM metadata
		 WHERE collection_id = ?
		   AND date(indexed_at) = ?
		   AND coalesce(is_trashed, 0) = 0
		   AND coalesce(is_private, 0) = 0`,
		collectionID, date,
	).Scan(&n)
	return n, err
}

// notifyFn sends one notification to all opted-in devices.
var notifyFn = push.NotifyAll

// handleBatchEnded is the batch watcher's onBatchEnded callback: fan out one
// notification per collection that received new items during the batch. The
// click-through query uses the batch's LOCAL end-date to match indexed_at,
// which is stored as datetime('now','localtime'); date(indexed_at) is therefore
// a local-date comparison. The body's count uses the SAME date (and the same
// visibility filters) so the number and the click-through agree.
func handleBatchEnded(b BatchEnded) {
	date := b.EndedAt.Local().Format("2006-01-02")
	// raw: is passed through to the FTS search as-is (see the README search
	// section); date(indexed_at) is a local-date match against the stored
	// localtime indexed_at. The double quotes are part of the raw: syntax and
	// survive JSON + the client's URL encoding intact.
	query := fmt.Sprintf(`raw:"date(indexed_at) = '%s'"`, date)

	for _, id := range b.CollectionIDs {
		name, ok := collectionNameFn(id)
		title := "New items added!"
		if ok {
			title = fmt.Sprintf("%s - new items added!", name)
		}

		// Body: today's indexed count for this collection, matching the click.
		// On a count error, omit the body rather than showing a wrong number.
		body := ""
		if n, err := countIndexedTodayFn(id, date); err == nil {
			if n == 1 {
				body = "1 item indexed today"
			} else {
				body = fmt.Sprintf("%d items indexed today", n)
			}
		} else {
			plLogger().Warn("batch notify: counting indexed items failed",
				"collection_id", id, "error", err)
		}

		notifyFn(push.Payload{
			Title:        title,
			Body:         body,
			CollectionID: id,
			Query:        query,
		})
	}
}
