package indexing

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"

	"github.com/google/uuid"

	"photo-loka/internal/collections"
	"photo-loka/internal/media"
	"photo-loka/internal/utils"
)

// SubmitEntry is the pipeline entry point, injected by the pipeline package at
// startup (pipeline.Init sets it). The indexing package's discovery functions
// (InitialIndexing, ScanForChanges, intake) call this to hand a newly found
// file to the orchestrator instead of enqueuing IndexFile directly. Using a
// function var (like collections.OnCollectionChanged) keeps indexing free of an
// import cycle on the pipeline package.
//
// Signature: (collection, sourceFile, existingUUID, inPlace).
var SubmitEntry func(collection *collections.Collection, sourceFile, existingUUID string, inPlace bool)

// SubmitRefresh routes a metadata-only re-extract (RefreshMetadata) through the
// pipeline, injected by the pipeline package at startup. Metadata refresh is
// not part of the media data flow (it does not re-place the file), so it has
// its own entry rather than going through bring-to-collection.
var SubmitRefresh func(uuid, filename string)

// Indexer admin control hooks, wired by the pipeline package at startup. These
// back the legacy /getIndexerStatus, /pauseIndexer, etc. endpoints during the
// pipeline transition. They are a stopgap: phase 5 of the pipeline design
// replaces these with per-stage /api/admin/pipeline/* endpoints. Until then
// they operate on the pipeline as a whole (aggregate/entry-stage semantics).
var (
	// PipelineStatus returns an aggregate status snapshot for the legacy status
	// endpoint. Shape is decided by the pipeline package.
	PipelineStatus func() map[string]interface{}
	// PipelinePause / PipelineResume pause/resume all stages.
	PipelinePause  func()
	PipelineResume func()
	// PipelineErrors aggregates recent errors across all stages.
	PipelineErrors func() interface{}
	// PipelineSetConcurrency sets the entry-stage concurrency (legacy
	// "indexer concurrency" knob).
	PipelineSetConcurrency func(n int)
)

// submit hands one file to the pipeline entry stage. No-op with a warning if
// the pipeline has not wired SubmitEntry yet (should not happen after startup).
func submit(collection *collections.Collection, sourceFile, existingUUID string, inPlace bool) {
	if SubmitEntry == nil {
		idxLogger().Error("pipeline SubmitEntry not wired; dropping file", "file", sourceFile)
		return
	}
	SubmitEntry(collection, sourceFile, existingUUID, inPlace)
}

// submitRefresh routes a metadata-only refresh through the pipeline.
func submitRefresh(uuid, filename string) {
	if SubmitRefresh == nil {
		idxLogger().Error("pipeline SubmitRefresh not wired; dropping refresh", "uuid", uuid)
		return
	}
	SubmitRefresh(uuid, filename)
}

// Submit hands a single file to the pipeline entry stage. Exported for callers
// outside this package (e.g. the file watcher) that discover new files.
func Submit(collection *collections.Collection, sourceFile, existingUUID string, inPlace bool) {
	submit(collection, sourceFile, existingUUID, inPlace)
}

// IndexerBusy reports whether the pipeline has any in-flight or pending work,
// used by scheduled intake to avoid starting while indexing is active. Wired by
// the pipeline package; returns false if not yet wired.
var PipelineBusy func() bool

// IndexerBusy reports whether the pipeline is currently processing work.
func IndexerBusy() bool {
	if PipelineBusy == nil {
		return false
	}
	return PipelineBusy()
}

// idxLogger resolves the current default handler at call time (see frames.frLogger).
func idxLogger() *slog.Logger { return slog.Default().With("component", "indexer") }

// BringToCollectionResult is the output of the entry stage: everything a
// downstream pipeline stage needs to proceed without re-reading the file.
type BringToCollectionResult struct {
	UUID       string
	FinalFile  string
	Mediatype  string
	ExifData   *media.ExifData
	IsNew      bool // true if a new row was inserted (existingUUID was "")
	CompressOK bool // collection wants video compression (video only)
}

// BringToCollection is the pipeline entry stage: extract metadata, place the
// file in the collection, generate/reuse the uuid, derive capture fields, and
// insert/update the DB row (including exiftool geo data). This is intentionally
// one stage: placement needs the capture date from exif, and the DB row must be
// committed here so every downstream stage can self-hydrate by uuid.
//
// It does NOT enqueue thumbnails, ML, geo, or compression; the orchestrator
// routes to those downstream stages. Callable standalone to (re)bring a file.
func BringToCollection(collection *collections.Collection, sourceFile string, existingUUID string, inPlace bool) (*BringToCollectionResult, error) {
	// Step 1: Extract metadata
	exifData, err := media.ExtractMetadata(sourceFile)
	if err != nil {
		return nil, fmt.Errorf("extracting metadata from %s: %w", sourceFile, err)
	}

	// Audio fallback: audio files typically lack EXIF date fields.
	// For intake audio files, use file_modified_at for folder placement.
	if exifData.CaptureDateTime == nil && !inPlace && exifData.Mediatype == "audio" {
		if exifData.FileModifiedAt != nil {
			exifData.CapturedAt = exifData.FileModifiedAt
			// Parse file_modified_at to build CaptureDateTime for folder placement
			if dt, ok := utils.ParseExifDate(*exifData.FileModifiedAt); ok {
				exifData.CaptureDateTime = &media.CaptureDateTime{
					Year:            dt.Year,
					Month:           dt.Month,
					Day:             dt.Day,
					Hour:            dt.Hour,
					Minute:          dt.Minute,
					Second:          dt.Second,
					TzOffsetMinutes: dt.TzOffsetMinutes,
				}
			}
			idxLogger().Info("audio file without EXIF date, using file_modified_at for placement", "file", sourceFile)
		}
	}

	// Step 2: Place file in collection
	placeResult, err := PlaceFileInCollection(collection, sourceFile, exifData.CaptureDateTime, inPlace)
	if err != nil {
		return nil, fmt.Errorf("placing file %s in collection: %w", sourceFile, err)
	}

	// Step 3: Generate or reuse UUID
	fileUUID := existingUUID
	if fileUUID == "" {
		fileUUID = uuid.New().String()
	}

	// Step 4: Derive capture date/time fields
	var captureDate, captureTime, captureTzOffset string
	if exifData.CaptureDateTime != nil {
		dt := exifData.CaptureDateTime
		captureDate = fmt.Sprintf("%04d-%02d-%02d", dt.Year, dt.Month, dt.Day)
		captureTime = fmt.Sprintf("%02d:%02d:%02d", dt.Hour, dt.Minute, dt.Second)
		if dt.TzOffsetMinutes != nil {
			offset := *dt.TzOffsetMinutes
			sign := "+"
			if offset < 0 {
				sign = "-"
				offset = -offset
			}
			captureTzOffset = fmt.Sprintf("%s%02d:%02d", sign, offset/60, offset%60)
		}
	}

	finalFile := placeResult.Filename

	// Step 5: Build and insert/update DB row
	row := buildMetadataRow(collection, fileUUID, placeResult, exifData, captureDate, captureTime, captureTzOffset)

	// Derive private/trashed status from the on-disk filename prefix so that
	// pre-existing files that were marked private (leading '.') or trashed
	// ('.Trash_') on disk are indexed with the correct flags. The stored
	// filename keeps its prefix, matching what the trash/private APIs and
	// restore/unmark operations expect. ".Trash_" is checked before "." since
	// a trashed file also begins with a dot.
	baseName := filepath.Base(placeResult.Filename)
	if _, isTrashed, isPrivate := utils.StripStatusPrefix(baseName); isTrashed {
		row["is_trashed"] = 1
		// No record exists of when a pre-existing file was trashed. Use the
		// file's modification time as a proxy (rename does not change mtime).
		// Normalize to SQLite's local datetime format to match trashed_at
		// values set by the API.
		if exifData.FileModifiedAt != nil {
			if dt, ok := utils.ParseExifDate(*exifData.FileModifiedAt); ok {
				row["trashed_at"] = dt.ToSQLiteLocal()
			}
		}
	} else if isPrivate {
		row["is_private"] = 1
	}

	if existingUUID != "" {
		// Update existing row
		if err := UpdateMetadata(row); err != nil {
			return nil, fmt.Errorf("updating metadata for %s: %w", fileUUID, err)
		}
	} else {
		// Insert new row
		if err := InsertMetadata(row); err != nil {
			return nil, fmt.Errorf("inserting metadata for %s: %w", fileUUID, err)
		}
	}

	// Store exiftool geolocation data in geo_lookups for the geo stage to use.
	// The geo finalization itself is a separate pipeline stage (see
	// pipeline.GeoLookup); here we only persist what exiftool already extracted.
	if exifData.GPSLat != nil && exifData.GPSLng != nil && exifData.ExiftoolGeoJSON != nil {
		hasData := false
		for _, v := range exifData.ExiftoolGeoJSON {
			if v != nil {
				hasData = true
				break
			}
		}
		if hasData {
			geoJSON, _ := json.Marshal(exifData.ExiftoolGeoJSON)
			if err := InsertGeoLookup(fileUUID, "exiftool", "geolocation", string(geoJSON)); err != nil {
				idxLogger().Warn("failed to store exiftool geo data", "uuid", fileUUID, "error", err)
			}
		}
	}

	compressOK := exifData.Mediatype == "video" &&
		collection.CompressVideos != nil && *collection.CompressVideos == 1

	idxLogger().Info("brought to collection",
		"uuid", fileUUID,
		"file", finalFile,
		"mediatype", exifData.Mediatype,
	)

	return &BringToCollectionResult{
		UUID:       fileUUID,
		FinalFile:  finalFile,
		Mediatype:  exifData.Mediatype,
		ExifData:   exifData,
		IsNew:      existingUUID == "",
		CompressOK: compressOK,
	}, nil
}

// RefreshMetadata re-extracts metadata for an already indexed file and updates the DB.
func RefreshMetadata(uuid string, filename string) error {
	exifData, err := media.ExtractMetadata(filename)
	if err != nil {
		return fmt.Errorf("extracting metadata for refresh of %s: %w", uuid, err)
	}

	// Derive capture date/time fields
	var captureDate, captureTime, captureTzOffset string
	if exifData.CaptureDateTime != nil {
		dt := exifData.CaptureDateTime
		captureDate = fmt.Sprintf("%04d-%02d-%02d", dt.Year, dt.Month, dt.Day)
		captureTime = fmt.Sprintf("%02d:%02d:%02d", dt.Hour, dt.Minute, dt.Second)
		if dt.TzOffsetMinutes != nil {
			offset := *dt.TzOffsetMinutes
			sign := "+"
			if offset < 0 {
				sign = "-"
				offset = -offset
			}
			captureTzOffset = fmt.Sprintf("%s%02d:%02d", sign, offset/60, offset%60)
		}
	}

	row := map[string]interface{}{
		"uuid": uuid,
	}

	// Populate row with extracted data
	if exifData.Description != nil {
		row["description"] = *exifData.Description
	}
	if exifData.Filesize != nil {
		row["filesize"] = *exifData.Filesize
	}
	row["ext"] = exifData.Ext
	if exifData.Mimetype != nil {
		row["mimetype"] = *exifData.Mimetype
	}
	row["mediatype"] = exifData.Mediatype
	if len(exifData.Keywords) > 0 {
		row["keywords"] = joinStrings(exifData.Keywords)
	}
	if exifData.Xmpregion != nil {
		row["xmpregion"] = *exifData.Xmpregion
	}
	// faces tri-state: nil = no XMP RegionInfo (leave NULL); non-nil (possibly
	// empty) = RegionInfo present, so store [] or the names.
	if exifData.Faces != nil {
		row["faces"] = joinStrings(exifData.Faces)
	}
	row["rating"] = exifData.Rating
	if exifData.ImageWidth != nil {
		row["image_width"] = *exifData.ImageWidth
	}
	if exifData.ImageHeight != nil {
		row["image_height"] = *exifData.ImageHeight
	}
	row["aspectratio"] = exifData.Aspectratio
	if exifData.Make != nil {
		row["make"] = *exifData.Make
	}
	if exifData.Model != nil {
		row["model"] = *exifData.Model
	}
	if exifData.Orientation != nil {
		row["orientation"] = *exifData.Orientation
	}
	if exifData.Duration != nil {
		row["duration"] = *exifData.Duration
	}
	if exifData.GPSLat != nil {
		row["gps_lat"] = *exifData.GPSLat
	}
	if exifData.GPSLng != nil {
		row["gps_lng"] = *exifData.GPSLng
	}
	if exifData.GPSAlt != nil {
		row["gps_alt"] = *exifData.GPSAlt
	}
	if exifData.FileModifiedAt != nil {
		row["file_modified_at"] = *exifData.FileModifiedAt
	}
	if exifData.CapturedAt != nil {
		row["captured_at"] = *exifData.CapturedAt
	}
	if captureDate != "" {
		row["capture_date"] = captureDate
	}
	if captureTime != "" {
		row["capture_time"] = captureTime
	}
	if captureTzOffset != "" {
		row["capture_tz_offset"] = captureTzOffset
	}
	if exifData.CaptureTzName != nil {
		row["capture_tz_name"] = *exifData.CaptureTzName
	}
	if exifData.ExifDatetimeOriginalRef != nil {
		row["exif_datetime_original_ref"] = *exifData.ExifDatetimeOriginalRef
	}
	if exifData.ExifCreateDateRef != nil {
		row["exif_create_date_ref"] = *exifData.ExifCreateDateRef
	}

	if err := UpdateMetadata(row); err != nil {
		return fmt.Errorf("updating metadata for %s: %w", uuid, err)
	}

	idxLogger().Debug("metadata refreshed", "uuid", uuid)
	return nil
}

// buildMetadataRow creates the map to insert/update in the metadata table.
func buildMetadataRow(collection *collections.Collection, fileUUID string, place *PlaceResult, exif *media.ExifData, captureDate, captureTime, captureTzOffset string) map[string]interface{} {
	row := map[string]interface{}{
		"collection_id": collection.CollectionID,
		"uuid":          fileUUID,
		"album_date":    place.AlbumDate,
		"album_name":    place.AlbumName,
		"filename":      place.Filename,
		"ext":           exif.Ext,
		"mediatype":     exif.Mediatype,
		"rating":        exif.Rating,
		"aspectratio":   exif.Aspectratio,
	}

	if exif.Description != nil {
		row["description"] = *exif.Description
	}
	if exif.Filesize != nil {
		row["filesize"] = *exif.Filesize
	}
	if exif.Mimetype != nil {
		row["mimetype"] = *exif.Mimetype
	}
	if len(exif.Keywords) > 0 {
		row["keywords"] = joinStrings(exif.Keywords)
	}
	if exif.Xmpregion != nil {
		row["xmpregion"] = *exif.Xmpregion
	}
	// faces tri-state: nil = no XMP RegionInfo (leave NULL, nothing known yet);
	// non-nil (possibly empty) = RegionInfo present, so store [] or the names.
	if exif.Faces != nil {
		row["faces"] = joinStrings(exif.Faces)
	}
	if exif.ImageWidth != nil {
		row["image_width"] = *exif.ImageWidth
	}
	if exif.ImageHeight != nil {
		row["image_height"] = *exif.ImageHeight
	}
	if exif.Make != nil {
		row["make"] = *exif.Make
	}
	if exif.Model != nil {
		row["model"] = *exif.Model
	}
	if exif.Orientation != nil {
		row["orientation"] = *exif.Orientation
	}
	if exif.Duration != nil {
		row["duration"] = *exif.Duration
	}
	if exif.GPSLat != nil {
		row["gps_lat"] = *exif.GPSLat
	}
	if exif.GPSLng != nil {
		row["gps_lng"] = *exif.GPSLng
	}
	if exif.GPSAlt != nil {
		row["gps_alt"] = *exif.GPSAlt
	}
	if exif.FileModifiedAt != nil {
		row["file_modified_at"] = *exif.FileModifiedAt
	}
	if exif.CapturedAt != nil {
		row["captured_at"] = *exif.CapturedAt
	}
	if captureDate != "" {
		row["capture_date"] = captureDate
	}
	if captureTime != "" {
		row["capture_time"] = captureTime
	}
	if captureTzOffset != "" {
		row["capture_tz_offset"] = captureTzOffset
	}
	if exif.CaptureTzName != nil {
		row["capture_tz_name"] = *exif.CaptureTzName
	}
	if exif.ExifDatetimeOriginalRef != nil {
		row["exif_datetime_original_ref"] = *exif.ExifDatetimeOriginalRef
	}
	if exif.ExifCreateDateRef != nil {
		row["exif_create_date_ref"] = *exif.ExifCreateDateRef
	}

	return row
}

// joinStrings serializes a string slice as a JSON array for DB storage.
// Node.js stores keywords and faces as JSON arrays: ["tag1","tag2"]
func joinStrings(ss []string) string {
	if len(ss) == 0 {
		return "[]"
	}
	b, _ := json.Marshal(ss)
	return string(b)
}
