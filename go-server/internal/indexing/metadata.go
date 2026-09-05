package indexing

import (
	"encoding/json"
	"fmt"
	"time"
)

// UpdateDescription updates the description for an item in the DB and schedules an exif write.
func (idx *Indexer) UpdateDescription(uuid, description string) {
	fileModifyDate := time.Now().Format("2006:01:02 15:04:05")

	if err := idx.db.UpdateDescription(uuid, description, fileModifyDate); err != nil {
		idx.logger.Error("failed to update description", "uuid", uuid, "error", err)
		return
	}

	// Schedule exif write
	exifUpdate := map[string]interface{}{
		"ImageDescription": description,
		"Description":      description,
	}

	exifJSON, err := json.Marshal(exifUpdate)
	if err != nil {
		idx.logger.Error("failed to marshal exif update", "uuid", uuid, "error", err)
		return
	}

	if err := idx.db.ScheduleExif([]string{uuid}, string(exifJSON)); err != nil {
		idx.logger.Error("failed to schedule exif write for description", "uuid", uuid, "error", err)
	}
}

// UpdateRating updates the rating for multiple items in the DB and schedules exif writes.
func (idx *Indexer) UpdateRating(uuids []string, newRating int) {
	if len(uuids) == 0 {
		return
	}

	fileModifyDate := time.Now().Format("2006:01:02 15:04:05")

	if err := idx.db.UpdateRating(uuids, newRating, fileModifyDate); err != nil {
		idx.logger.Error("failed to update rating",
			"uuids", fmt.Sprintf("%v", uuids),
			"rating", newRating,
			"error", err,
		)
		return
	}

	// Schedule exif write
	exifUpdate := map[string]interface{}{
		"Rating": newRating,
	}

	exifJSON, err := json.Marshal(exifUpdate)
	if err != nil {
		idx.logger.Error("failed to marshal exif rating update", "error", err)
		return
	}

	if err := idx.db.ScheduleExif(uuids, string(exifJSON)); err != nil {
		idx.logger.Error("failed to schedule exif write for rating", "error", err)
	}
}
