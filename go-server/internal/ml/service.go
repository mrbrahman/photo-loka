package ml

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"

	"photo-loka/internal/config"
	"photo-loka/internal/media"
)

// ML operations (face recognition, image encoding) are package-level functions.
// client is the ML HTTP client, built once via Init; face/thumbnail dirs are
// read from config.Startup at use time.
var (
	client *apiClient
)

// log resolves the current default handler at call time (see frames.frLogger).
func log() *slog.Logger { return slog.Default().With("component", "ml-service") }

// Init builds the ML service HTTP client from config.Startup. Called once at
// startup, after LoadStartupConfig.
func Init() {
	client = newAPIClient(config.Startup.MLServiceURL)
}

// ProcessFaceRecognition runs face recognition for a media item.
// mlBuf is a pre-produced 640px buffer from the thumbnail step; pass nil to
// have the service produce it here (e.g. on-demand API calls). When nil, the
// service loads the file via libvips -- using the pre-extracted first-frame
// JPEG for videos -- and falls back to the path-based ML endpoint if that
// also fails (e.g. format unsupported).
func ProcessFaceRecognition(uuid string, mlBuf *media.MLBuffer) (map[string]interface{}, error) {
	// Get item info from DB for the ML call
	item, err := getItemForRecognition(uuid)
	if err != nil {
		return nil, fmt.Errorf("failed to get item info for %s: %w", uuid, err)
	}

	var xmpRegions interface{}
	if item.Xmpregion != nil && *item.Xmpregion != "" {
		if err := json.Unmarshal([]byte(*item.Xmpregion), &xmpRegions); err != nil {
			xmpRegions = nil
		}
	}

	// The file that ML actually "sees": the original for images, the
	// pre-extracted first-frame JPEG for videos (libvips cannot open a video
	// container). Used both to produce the buffer and to crop face thumbnails,
	// so the scaled-up bbox (in this file's pixel space) matches the crop source.
	feedFile := item.Filename
	if item.Mediatype == "video" {
		feedFile = media.VideoFramePath(uuid, config.Startup.ThumbsDir)
	}

	// If no buffer was supplied by the caller, produce one now.
	if mlBuf == nil {
		mlBuf, _ = media.ExportMLBuffer(uuid, feedFile)
	}

	var result map[string]interface{}
	if mlBuf != nil {
		imageBytes := base64.StdEncoding.EncodeToString(mlBuf.JPEG)
		result, err = client.RecognizeFacesBuffer(uuid, imageBytes, item.Orientation, xmpRegions)
		if err != nil {
			return nil, fmt.Errorf("face recognition (buffer) failed for %s: %w", uuid, err)
		}
		scaleFaceBboxes(result, mlBuf.Scale)
	} else {
		// Fallback: path-based endpoint (Python reads the file directly).
		result, err = client.RecognizeFaces(uuid, item.Filename, item.Orientation, xmpRegions)
		if err != nil {
			return nil, fmt.Errorf("face recognition failed for %s: %w", uuid, err)
		}
	}

	// Extract faces and unmatched from result
	var faces []map[string]interface{}
	var unmatched []map[string]interface{}

	if f, ok := result["faces"].([]interface{}); ok {
		for _, item := range f {
			if m, ok := item.(map[string]interface{}); ok {
				faces = append(faces, m)
			}
		}
	}

	if u, ok := result["unmatched_input_faces"].([]interface{}); ok {
		for _, item := range u {
			if m, ok := item.(map[string]interface{}); ok {
				unmatched = append(unmatched, m)
			}
		}
	}

	// Save results to DB
	if err := saveFaceResults(uuid, faces, unmatched); err != nil {
		return nil, fmt.Errorf("failed to save face results for %s: %w", uuid, err)
	}

	// Extract face thumbnails from the crop source (feedFile): the original for
	// images, the extracted frame for videos. bbox is in feedFile pixel space
	// after the scale-up above, so the crop source must match feedFile.
	if len(faces) > 0 {
		if err := media.ExtractFaceThumbnails(uuid, feedFile, faces, config.Startup.FacesDir); err != nil {
			log().Warn("face thumbnail extraction failed", "uuid", uuid, "error", err)
		}
	}

	log().Info("face recognition complete", "uuid", uuid, "faces", len(faces), "unmatched", len(unmatched))
	return result, nil
}

// scaleFaceBboxes multiplies every face bbox coordinate by scale, converting
// from 640px fed-image space back to full-resolution rotated space.
func scaleFaceBboxes(result map[string]interface{}, scale float64) {
	faces, ok := result["faces"].([]interface{})
	if !ok {
		return
	}
	for _, f := range faces {
		face, ok := f.(map[string]interface{})
		if !ok {
			continue
		}
		if bboxRaw, ok := face["bbox"].([]interface{}); ok {
			scaled := make([]interface{}, len(bboxRaw))
			for i, v := range bboxRaw {
				if fv, ok := v.(float64); ok {
					scaled[i] = fv * scale
				} else {
					scaled[i] = v
				}
			}
			face["bbox"] = scaled
		}
	}
}

// ProcessImageEncoding generates and stores a CLIP embedding for a media item.
// mlBuf is a pre-produced 640px buffer from the thumbnail step; pass nil to
// have the service produce it here. No-ops if buffer production fails (CLIP
// encoding is not available via the path-based endpoint).
func ProcessImageEncoding(uuid string, mlBuf *media.MLBuffer) error {
	if mlBuf == nil {
		item, err := getItemForRecognition(uuid)
		if err != nil {
			return fmt.Errorf("failed to get item info for encoding %s: %w", uuid, err)
		}
		feedFile := item.Filename
		if item.Mediatype == "video" {
			feedFile = media.VideoFramePath(uuid, config.Startup.ThumbsDir)
		}
		mlBuf, _ = media.ExportMLBuffer(uuid, feedFile)
	}

	if mlBuf == nil {
		return nil
	}

	imageBytes := base64.StdEncoding.EncodeToString(mlBuf.JPEG)
	_, err := client.EncodeImageBuffer(uuid, imageBytes)
	if err != nil {
		return fmt.Errorf("image encoding failed for %s: %w", uuid, err)
	}

	log().Info("image encoding complete", "uuid", uuid)
	return nil
}

// GetFacesByUUID returns all face records for a given uuid.
func GetFacesByUUID(uuid string) ([]map[string]interface{}, error) {
	return getFacesByUUID(uuid)
}

// GetFacesByPerson returns all face records for a given person name.
func GetFacesByPerson(name string) ([]map[string]interface{}, error) {
	return queryFacesByPerson(name)
}

// NameFaceCluster assigns a name to a face cluster in both the ML service and DB.
func NameFaceCluster(clusterID, name string) (int64, error) {
	// Update ML service
	if err := client.NameFaceCluster(clusterID, name); err != nil {
		return 0, fmt.Errorf("failed to name cluster in ML service: %w", err)
	}

	// Update local DB
	rowsAffected, err := nameFaceClusterDB(clusterID, name)
	if err != nil {
		return 0, fmt.Errorf("failed to name cluster in DB: %w", err)
	}

	log().Info("named face cluster", "cluster_id", clusterID, "name", name, "rows_affected", rowsAffected)
	return rowsAffected, nil
}

// UpdatePersonName renames a person in both the ML service and DB.
func UpdatePersonName(oldName, newName string) (int64, error) {
	// Update ML service
	if err := client.UpdatePersonName(oldName, newName); err != nil {
		return 0, fmt.Errorf("failed to update person name in ML service: %w", err)
	}

	// Update local DB
	rowsAffected, err := updatePersonNameDB(oldName, newName)
	if err != nil {
		return 0, fmt.Errorf("failed to update person name in DB: %w", err)
	}

	log().Info("updated person name", "old_name", oldName, "new_name", newName, "rows_affected", rowsAffected)
	return rowsAffected, nil
}

// GetFaceSuggestions retrieves name suggestions for a face cluster from the ML service.
func GetFaceSuggestions(clusterID string) (map[string]interface{}, error) {
	return client.GetFaceSuggestions(clusterID)
}

// Available reports whether the ML client has been initialized (i.e. Init was
// called). Used by callers that must degrade gracefully when ML is not wired.
func Available() bool {
	return client != nil
}

// SearchByText performs semantic (CLIP) search via the ML service and returns
// the raw response.
func SearchByText(query string) (map[string]interface{}, error) {
	return client.SearchByText(query)
}

// SearchPersonNames searches for person names matching a query string.
func SearchPersonNames(query string) ([]string, error) {
	return searchPersonNamesDB(query)
}

// DismissCluster marks a face cluster as dismissed.
func DismissCluster(clusterID string) error {
	if err := dismissClusterDB(clusterID); err != nil {
		return err
	}
	log().Info("dismissed cluster", "cluster_id", clusterID)
	return nil
}

// UndismissCluster restores a dismissed face cluster.
func UndismissCluster(clusterID string) error {
	if err := undismissClusterDB(clusterID); err != nil {
		return err
	}
	log().Info("undismissed cluster", "cluster_id", clusterID)
	return nil
}

// CleanupMLData removes all ML data for a uuid from both the DB and external ML service.
func CleanupMLData(uuid string) {
	// Delete from local DB
	clusterIDs, err := deleteFaceData(uuid)
	if err != nil {
		log().Error("failed to delete face data from DB", "uuid", uuid, "error", err)
	} else if len(clusterIDs) > 0 {
		log().Info("deleted face data", "uuid", uuid, "cluster_ids", clusterIDs)
	}

	// Call ML service cleanup (logs errors internally)
	client.CleanupMLData(uuid)
}
