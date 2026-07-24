package items

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/indexing"
	"photo-loka/internal/media"
	"photo-loka/internal/ml"
)

// Handler provides HTTP route handlers for item operations.
type Handler struct {
	indexer   *indexing.Indexer
	organizer *indexing.Organizer
	mlService *ml.Service
	thumbsDir string
	logger    *slog.Logger
}

// NewHandler creates a new items Handler.
func NewHandler(indexer *indexing.Indexer, org *indexing.Organizer, mlSvc *ml.Service, thumbsDir string) *Handler {
	return &Handler{
		indexer:   indexer,
		organizer: org,
		mlService: mlSvc,
		thumbsDir: thumbsDir,
		logger:    slog.Default().With("component", "items-handler"),
	}
}

// RegisterRoutes registers all item-related routes on the given router group.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup) {
	rg.PUT("/updateRating", h.updateRating)
	rg.PUT("/updateDescription", h.updateDescription)
	rg.PUT("/renameFile", h.renameFile)
	rg.PUT("/refreshThumbs/:uuid", h.refreshThumbs)
	rg.PUT("/compressVideo/:uuid", h.compressVideo)
	rg.DELETE("/trashItems", h.trashItems)
	rg.PUT("/togglePrivate", h.togglePrivate)
	rg.PUT("/restoreFromTrash", h.restoreFromTrash)
	rg.DELETE("/cleanupTrash", h.cleanupTrash)
	rg.DELETE("/emptyTrash", h.emptyTrash)
}

// updateRating updates the rating (stars) for one or more items.
// PUT /updateRating (body: {uuid_arr, newRating})
func (h *Handler) updateRating(c *gin.Context) {
	var body struct {
		UUIDs     []string `json:"uuid_arr" binding:"required"`
		NewRating int      `json:"newRating"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid request body: " + err.Error(),
			"code":    "INVALID_BODY",
		}})
		return
	}

	// file_modified_at is set to now so that the exif write scheduler picks it up
	fileModifyDate := time.Now().Format("2006-01-02 15:04:05")

	if err := h.indexer.DB().UpdateRating(body.UUIDs, body.NewRating, fileModifyDate); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to update rating: " + err.Error(),
			"code":    "DB_ERROR",
		}})
		return
	}

	// Schedule exif write for rating
	exifUpdate := map[string]interface{}{"Rating": body.NewRating}
	exifJSON, _ := json.Marshal(exifUpdate)
	if err := h.indexer.DB().ScheduleExif(body.UUIDs, string(exifJSON)); err != nil {
		h.logger.Error("failed to schedule exif write for rating", "error", err)
	}

	c.JSON(http.StatusOK, gin.H{"message": "rating updated", "count": len(body.UUIDs)})
}

// updateDescription updates the description for a single item.
// PUT /updateDescription (body: {uuid, description})
func (h *Handler) updateDescription(c *gin.Context) {
	var body struct {
		UUID        string `json:"uuid" binding:"required"`
		Description string `json:"description"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid request body: " + err.Error(),
			"code":    "INVALID_BODY",
		}})
		return
	}

	fileModifyDate := time.Now().Format("2006-01-02 15:04:05")

	if err := h.indexer.DB().UpdateDescription(body.UUID, body.Description, fileModifyDate); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to update description: " + err.Error(),
			"code":    "DB_ERROR",
		}})
		return
	}

	// Schedule exif write for description
	exifUpdate := map[string]interface{}{"ImageDescription": body.Description}
	exifJSON, _ := json.Marshal(exifUpdate)
	if err := h.indexer.DB().ScheduleExif([]string{body.UUID}, string(exifJSON)); err != nil {
		h.logger.Error("failed to schedule exif write for description", "error", err)
	}

	c.JSON(http.StatusOK, gin.H{"message": "description updated"})
}

// renameFile renames a media file.
// PUT /renameFile (body: {collection_id, uuid, newBasename})
func (h *Handler) renameFile(c *gin.Context) {
	var body struct {
		CollectionID int64  `json:"collection_id" binding:"required"`
		UUID         string `json:"uuid" binding:"required"`
		NewBasename  string `json:"newBasename" binding:"required"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid request body: " + err.Error(),
			"code":    "INVALID_BODY",
		}})
		return
	}

	// Get current filename from DB
	oldFilename, err := h.indexer.DB().GetFileName(body.UUID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
			"message": "item not found: " + err.Error(),
			"code":    "NOT_FOUND",
		}})
		return
	}

	// Build new path with the new basename in the same directory
	dir := filepath.Dir(oldFilename)
	newFilename := filepath.Join(dir, body.NewBasename)

	// Move (rename) the file
	if err := h.organizer.MoveItem(body.CollectionID, oldFilename, newFilename, false); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to rename file: " + err.Error(),
			"code":    "FS_ERROR",
		}})
		return
	}

	// Update DB filename
	if err := h.indexer.DB().UpdateFilename(body.UUID, newFilename); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "file renamed but DB update failed: " + err.Error(),
			"code":    "DB_ERROR",
		}})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "file renamed", "filename": newFilename})
}

// refreshThumbs regenerates thumbnails for an item.
// PUT /refreshThumbs/:uuid
func (h *Handler) refreshThumbs(c *gin.Context) {
	uuid := c.Param("uuid")
	if uuid == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "uuid is required",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	filename, err := h.indexer.DB().GetFileName(uuid)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
			"message": "item not found: " + err.Error(),
			"code":    "NOT_FOUND",
		}})
		return
	}

	// Determine if video or image based on extension
	ext := filepath.Ext(filename)
	isVideo := isVideoExtension(ext)

	go func() {
		if isVideo {
			// Extract a frame from the video first
			framePath, err := media.GenerateVideoThumbnail(uuid, filename, h.thumbsDir)
			if err != nil {
				h.logger.Error("video thumbnail extraction failed", "uuid", uuid, "error", err)
				return
			}
			// Generate standard thumbnails from the extracted frame
			if err := media.CreateImageThumbnails(uuid, framePath, h.thumbsDir); err != nil {
				h.logger.Error("thumbnail creation from video frame failed", "uuid", uuid, "error", err)
			}
		} else {
			if err := media.CreateImageThumbnails(uuid, filename, h.thumbsDir); err != nil {
				h.logger.Error("thumbnail creation failed", "uuid", uuid, "error", err)
			}
		}
		h.logger.Info("thumbnails refreshed", "uuid", uuid)
	}()

	c.JSON(http.StatusAccepted, gin.H{"message": "thumbnail refresh started", "uuid": uuid})
}

// compressVideo queues video compression for an item.
// PUT /compressVideo/:uuid
func (h *Handler) compressVideo(c *gin.Context) {
	uuid := c.Param("uuid")
	if uuid == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "uuid is required",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	filename, err := h.indexer.DB().GetFileName(uuid)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
			"message": "item not found: " + err.Error(),
			"code":    "NOT_FOUND",
		}})
		return
	}

	go func() {
		encoder := media.EncoderVP9 // default encoder
		if err := media.CompressVideo(uuid, filename, h.thumbsDir, encoder); err != nil {
			h.logger.Error("video compression failed", "uuid", uuid, "error", err)
		} else {
			h.logger.Info("video compression complete", "uuid", uuid)
		}
	}()

	c.JSON(http.StatusAccepted, gin.H{"message": "video compression started", "uuid": uuid})
}

// trashItems moves items to the collection's .trash folder.
// DELETE /trashItems (body: {collection_id, uuid_arr})
func (h *Handler) trashItems(c *gin.Context) {
	var body struct {
		CollectionID int64    `json:"collection_id" binding:"required"`
		UUIDs        []string `json:"uuid_arr" binding:"required"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid request body: " + err.Error(),
			"code":    "INVALID_BODY",
		}})
		return
	}

	if err := h.organizer.MoveFileToTrash(body.CollectionID, body.UUIDs); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to trash items: " + err.Error(),
			"code":    "FS_ERROR",
		}})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "items trashed", "count": len(body.UUIDs)})
}

// togglePrivate marks or unmarks items as private.
// PUT /togglePrivate (body: {collection_id, uuid_arr, makePrivate})
func (h *Handler) togglePrivate(c *gin.Context) {
	var body struct {
		CollectionID int64    `json:"collection_id" binding:"required"`
		UUIDs        []string `json:"uuid_arr" binding:"required"`
		MakePrivate  bool     `json:"makePrivate"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid request body: " + err.Error(),
			"code":    "INVALID_BODY",
		}})
		return
	}

	var err error
	if body.MakePrivate {
		err = h.organizer.MarkFilePrivate(body.CollectionID, body.UUIDs)
	} else {
		err = h.organizer.UnmarkFilePrivate(body.CollectionID, body.UUIDs)
	}

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to toggle private: " + err.Error(),
			"code":    "FS_ERROR",
		}})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "private toggled", "count": len(body.UUIDs)})
}

// restoreFromTrash restores items from the .trash folder.
// PUT /restoreFromTrash (body: {collection_id, uuid_arr})
func (h *Handler) restoreFromTrash(c *gin.Context) {
	var body struct {
		CollectionID int64    `json:"collection_id" binding:"required"`
		UUIDs        []string `json:"uuid_arr" binding:"required"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid request body: " + err.Error(),
			"code":    "INVALID_BODY",
		}})
		return
	}

	if err := h.organizer.RestoreFromTrash(body.CollectionID, body.UUIDs); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to restore items: " + err.Error(),
			"code":    "FS_ERROR",
		}})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "items restored", "count": len(body.UUIDs)})
}

// cleanupTrash permanently deletes specific trashed items and their associated data.
// DELETE /cleanupTrash (body: {collection_id, uuid_arr})
func (h *Handler) cleanupTrash(c *gin.Context) {
	var body struct {
		CollectionID int64    `json:"collection_id" binding:"required"`
		UUIDs        []string `json:"uuid_arr" binding:"required"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid request body: " + err.Error(),
			"code":    "INVALID_BODY",
		}})
		return
	}

	errors := h.permanentlyDeleteItems(body.UUIDs)
	if len(errors) > 0 {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{
				"message": fmt.Sprintf("failed to cleanup %d of %d items", len(errors), len(body.UUIDs)),
				"code":    "PARTIAL_FAILURE",
			},
			"errors": errors,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "trash cleaned up", "count": len(body.UUIDs)})
}

// emptyTrash permanently deletes all specified trashed items.
// DELETE /emptyTrash (body: {collection_id, uuid_arr})
func (h *Handler) emptyTrash(c *gin.Context) {
	var body struct {
		CollectionID int64    `json:"collection_id" binding:"required"`
		UUIDs        []string `json:"uuid_arr" binding:"required"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid request body: " + err.Error(),
			"code":    "INVALID_BODY",
		}})
		return
	}

	errors := h.permanentlyDeleteItems(body.UUIDs)
	if len(errors) > 0 {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{
				"message": fmt.Sprintf("failed to empty %d of %d items", len(errors), len(body.UUIDs)),
				"code":    "PARTIAL_FAILURE",
			},
			"errors": errors,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "trash emptied", "count": len(body.UUIDs)})
}

// permanentlyDeleteItems removes files, thumbnails, face data, and metadata rows.
// Returns a list of error strings for items that failed.
func (h *Handler) permanentlyDeleteItems(uuids []string) []string {
	var errs []string

	// Get filenames for all items
	filenames, err := h.indexer.DB().GetFileNames(uuids)
	if err != nil {
		return []string{"failed to get filenames: " + err.Error()}
	}

	for _, uuid := range uuids {
		filename, ok := filenames[uuid]

		// 1. Delete the physical file (if it exists)
		if ok && filename != "" {
			if err := os.Remove(filename); err != nil && !os.IsNotExist(err) {
				h.logger.Error("failed to delete file", "uuid", uuid, "file", filename, "error", err)
				errs = append(errs, fmt.Sprintf("%s: failed to delete file: %v", uuid, err))
				continue
			}
		}

		// 2. Delete thumbnails
		media.DeleteThumbnails(uuid, h.thumbsDir)

		// 3. Delete compressed video files
		media.DeleteCompressedVideo(uuid, h.thumbsDir)

		// 4. Cleanup face/ML data (DB + external ML service)
		h.mlService.CleanupMLData(uuid)

		// 5. Delete metadata row from DB
		if err := h.indexer.DB().DeleteMetadata(uuid); err != nil {
			h.logger.Error("failed to delete metadata", "uuid", uuid, "error", err)
			errs = append(errs, fmt.Sprintf("%s: failed to delete metadata: %v", uuid, err))
			continue
		}

		h.logger.Debug("permanently deleted item", "uuid", uuid)
	}

	return errs
}

// isVideoExtension checks if a file extension belongs to a video format.
func isVideoExtension(ext string) bool {
	switch ext {
	case ".mp4", ".mov", ".avi", ".mkv", ".wmv", ".flv", ".webm", ".m4v", ".3gp",
		".MP4", ".MOV", ".AVI", ".MKV", ".WMV", ".FLV", ".WEBM", ".M4V", ".3GP":
		return true
	}
	return false
}
