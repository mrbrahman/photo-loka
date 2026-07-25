package indexing

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/google/uuid"

	"photo-loka/internal/collections"
	"photo-loka/internal/config"
	"photo-loka/internal/geo"
	"photo-loka/internal/media"
	"photo-loka/internal/ml"
	"photo-loka/internal/queue"
)

// Indexer orchestrates the indexing pipeline for media files.
type Indexer struct {
	db            *IndexingDB
	organizer     *Organizer
	indexQueue    *queue.Queue
	videoQueue    *queue.Queue
	thumbsDir     string
	config        *config.RuntimeConfig
	collectionsDB *collections.CollectionsDB
	geoService    *geo.Service
	mlService     *ml.Service
	logger        *slog.Logger
}

// NewIndexer creates a new Indexer instance.
func NewIndexer(db *IndexingDB, org *Organizer, indexQueue, videoQueue *queue.Queue, thumbsDir string, cfg *config.RuntimeConfig, colDB *collections.CollectionsDB) *Indexer {
	return &Indexer{
		db:            db,
		organizer:     org,
		indexQueue:    indexQueue,
		videoQueue:    videoQueue,
		thumbsDir:     thumbsDir,
		config:        cfg,
		collectionsDB: colDB,
		logger:        slog.Default().With("component", "indexer"),
	}
}

// SetGeoService sets the geo service for geo finalization after indexing.
func (idx *Indexer) SetGeoService(gs *geo.Service) {
	idx.geoService = gs
}

// SetMLService sets the ML service for face recognition after indexing.
func (idx *Indexer) SetMLService(ms *ml.Service) {
	idx.mlService = ms
}

// DB returns the IndexingDB instance for direct access by other packages.
func (idx *Indexer) DB() *IndexingDB {
	return idx.db
}

// IndexQueue returns the indexing queue for external enqueue operations.
func (idx *Indexer) IndexQueue() *queue.Queue {
	return idx.indexQueue
}

// IndexFile runs the full indexing pipeline for a single file:
// 1. Extract metadata (exif)
// 2. Place file in collection folder
// 3. Generate/reuse UUID
// 4. Derive capture_date, capture_time, capture_tz_offset from CaptureDateTime
// 5. Generate thumbnail
// 6. Queue video compression if enabled
// 7. Insert or update DB row
// 8. Log completion time
func (idx *Indexer) IndexFile(collection *collections.Collection, sourceFile string, existingUUID string, inPlace bool) error {
	start := time.Now()

	// Step 1: Extract metadata
	exifData, err := media.ExtractMetadata(sourceFile)
	if err != nil {
		return fmt.Errorf("extracting metadata from %s: %w", sourceFile, err)
	}

	// Audio fallback: audio files typically lack EXIF date fields.
	// For intake audio files, use file_modified_at for folder placement.
	if exifData.CaptureDateTime == nil && !inPlace && exifData.Mediatype == "audio" {
		if exifData.FileModifiedAt != nil {
			exifData.CapturedAt = exifData.FileModifiedAt
			// Parse file_modified_at to build CaptureDateTime for folder placement
			exifData.CaptureDateTime = parseDateToCaptureDateTime(*exifData.FileModifiedAt)
			idx.logger.Info("audio file without EXIF date, using file_modified_at for placement", "file", sourceFile)
		}
	}

	// Step 2: Place file in collection
	placeResult, err := idx.organizer.PlaceFileInCollection(collection, sourceFile, exifData.CaptureDateTime, inPlace)
	if err != nil {
		return fmt.Errorf("placing file %s in collection: %w", sourceFile, err)
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

	// Step 5: Generate thumbnail
	finalFile := placeResult.Filename

	if exifData.Mediatype == "video" {
		// Extract a frame from the video first, then generate thumbnails from that frame
		framePath, err := media.GenerateVideoThumbnail(fileUUID, finalFile, idx.thumbsDir)
		if err != nil {
			idx.logger.Warn("video thumbnail extraction failed", "file", finalFile, "error", err)
		} else {
			// Generate standard thumbnails from the extracted frame
			if err := media.CreateImageThumbnails(fileUUID, framePath, idx.thumbsDir); err != nil {
				idx.logger.Warn("thumbnail creation from video frame failed", "file", finalFile, "error", err)
			}
		}
	} else if exifData.Mediatype == "image" {
		if err := media.CreateImageThumbnails(fileUUID, finalFile, idx.thumbsDir); err != nil {
			idx.logger.Warn("thumbnail creation failed", "file", finalFile, "error", err)
		}
	}

	// Step 6: Queue video compression if enabled
	// NOTE: Node.js checks for an existing _compressed_video.webm file beside the source
	// and moves it to the thumbs dir instead of re-encoding. Not implemented here;
	// videos will always be enqueued for compression if the collection has compress_videos enabled.
	if exifData.Mediatype == "video" && collection.CompressVideos != nil && *collection.CompressVideos == 1 {
		encoder := idx.config.VideoEncoder
		if encoder == "" {
			encoder = media.EncoderVP9
		}

		vidUUID := fileUUID
		vidFile := finalFile
		idx.indexQueue.Enqueue(queue.Task{
			Priority:    queue.Low,
			Description: vidFile,
			Fn: func() error {
				return media.CompressVideo(vidUUID, vidFile, idx.thumbsDir, encoder)
			},
		})
	}

	// Step 7: Build and insert/update DB row
	row := buildMetadataRow(collection, fileUUID, placeResult, exifData, captureDate, captureTime, captureTzOffset)

	if existingUUID != "" {
		// Update existing row
		if err := idx.db.UpdateMetadata(row); err != nil {
			return fmt.Errorf("updating metadata for %s: %w", fileUUID, err)
		}
	} else {
		// Insert new row
		if err := idx.db.InsertMetadata(row); err != nil {
			return fmt.Errorf("inserting metadata for %s: %w", fileUUID, err)
		}
	}

	// Step 8: Store exiftool geo data and enqueue geo finalization
	if exifData.GPSLat != nil && exifData.GPSLng != nil {
		// Store exiftool geolocation data in geo_lookups for the finalizer to use
		if exifData.ExiftoolGeoJSON != nil {
			hasData := false
			for _, v := range exifData.ExiftoolGeoJSON {
				if v != nil {
					hasData = true
					break
				}
			}
			if hasData {
				geoJSON, _ := json.Marshal(exifData.ExiftoolGeoJSON)
				if err := idx.db.InsertGeoLookup(fileUUID, "exiftool", "geolocation", string(geoJSON)); err != nil {
					idx.logger.Warn("failed to store exiftool geo data", "uuid", fileUUID, "error", err)
				}
			}
		}

		// Enqueue geo finalization
		if idx.geoService != nil {
			opts := map[string]interface{}{
				"gps_lat": *exifData.GPSLat,
				"gps_lng": *exifData.GPSLng,
			}
			if exifData.ExiftoolGeoJSON != nil {
				if cc, ok := exifData.ExiftoolGeoJSON["GeolocationCountryCode"].(string); ok {
					opts["country_code"] = cc
				}
			}
			idx.geoService.Enqueue(fileUUID, opts)
		}
	}

	// Step 9: Enqueue face recognition for images
	if exifData.Mediatype == "image" && idx.mlService != nil && idx.config.PerformFaceRecognition {
		mlSvc := idx.mlService
		faceUUID := fileUUID
		idx.indexQueue.Enqueue(queue.Task{
			Priority:    queue.Normal,
			Description: "face:" + faceUUID,
			Fn: func() error {
				_, err := mlSvc.ProcessFaceRecognition(faceUUID)
				return err
			},
		})
	}

	// Step 10: Log completion
	duration := time.Since(start)
	idx.logger.Info("file indexed",
		"uuid", fileUUID,
		"file", finalFile,
		"mediatype", exifData.Mediatype,
		"duration", duration.String(),
	)

	return nil
}

// RefreshMetadata re-extracts metadata for an already indexed file and updates the DB.
func (idx *Indexer) RefreshMetadata(uuid string, filename string) error {
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
	if len(exifData.Faces) > 0 {
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

	if err := idx.db.UpdateMetadata(row); err != nil {
		return fmt.Errorf("updating metadata for %s: %w", uuid, err)
	}

	idx.logger.Debug("metadata refreshed", "uuid", uuid)
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
	if len(exif.Faces) > 0 {
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

// parseDateToCaptureDateTime attempts to parse a date string into CaptureDateTime.
// Handles formats like "2025:09:15 11:33:34-04:00" or "2025-09-15T11:33:34-04:00"
func parseDateToCaptureDateTime(dateStr string) *media.CaptureDateTime {
	// Try common exiftool date formats
	formats := []string{
		"2006:01:02 15:04:05-07:00",
		"2006:01:02 15:04:05",
		"2006-01-02T15:04:05-07:00",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
	}

	for _, fmt := range formats {
		if t, err := time.Parse(fmt, dateStr); err == nil {
			dt := &media.CaptureDateTime{
				Year:   t.Year(),
				Month:  int(t.Month()),
				Day:    t.Day(),
				Hour:   t.Hour(),
				Minute: t.Minute(),
				Second: t.Second(),
			}
			_, offset := t.Zone()
			if offset != 0 {
				offsetMin := offset / 60
				dt.TzOffsetMinutes = &offsetMin
			}
			return dt
		}
	}
	return nil
}

// formatTzOffset formats a timezone offset in minutes to "+HH:MM" or "-HH:MM".
func formatTzOffset(offsetMinutes int) string {
	sign := "+"
	if offsetMinutes < 0 {
		sign = "-"
		offsetMinutes = -offsetMinutes
	}
	return sign + padInt(offsetMinutes/60, 2) + ":" + padInt(offsetMinutes%60, 2)
}

// padInt formats an integer with leading zeros to the specified width.
func padInt(n, width int) string {
	s := strconv.Itoa(n)
	for len(s) < width {
		s = "0" + s
	}
	return s
}
