package albums

import (
	"net/http"
	"os"
	"strconv"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/collections"
)

// Organizer is the interface for album folder operations.
type Organizer interface {
	RenameAlbumFolder(collection *collections.Collection, currAlbumDate, currAlbumName, newAlbumDate, newAlbumName string) error
	AlbumFolderAbsPath(collection *collections.Collection, albumDate, albumName string) string
}

// Handler provides HTTP handlers for album operations.
type Handler struct {
	albumsDB      *AlbumsDB
	collectionsDB *collections.CollectionsDB
	organizer     Organizer
}

// NewHandler creates a new albums Handler.
func NewHandler(albumsDB *AlbumsDB, collectionsDB *collections.CollectionsDB, organizer Organizer) *Handler {
	return &Handler{
		albumsDB:      albumsDB,
		collectionsDB: collectionsDB,
		organizer:     organizer,
	}
}

// RegisterRoutes registers album routes on the given router group.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup) {
	rg.POST("/updateAlbumName", h.updateAlbumName)
}

// updateAlbumNameRequest is the request body for album rename.
type updateAlbumNameRequest struct {
	CollectionID int64  `json:"collection_id"`
	AlbumDate    string `json:"album_date"`
	CurrAlbumName string `json:"currAlbumName"`
	NewAlbumName  string `json:"newAlbumName"`
}

// updateAlbumName renames an album and updates file paths.
func (h *Handler) updateAlbumName(c *gin.Context) {
	var req updateAlbumNameRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Invalid request body: " + err.Error(), "code": "VALIDATION_ERROR"},
		})
		return
	}

	if req.CollectionID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "collection_id is required", "code": "VALIDATION_ERROR"},
		})
		return
	}

	if req.AlbumDate == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "album_date is required", "code": "VALIDATION_ERROR"},
		})
		return
	}

	if req.CurrAlbumName == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "currAlbumName is required", "code": "VALIDATION_ERROR"},
		})
		return
	}

	if req.NewAlbumName == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "newAlbumName is required", "code": "VALIDATION_ERROR"},
		})
		return
	}

	// Look up collection
	collection, err := h.collectionsDB.Get(req.CollectionID)
	if err != nil || collection == nil {
		c.JSON(http.StatusNotFound, gin.H{
			"error": gin.H{"message": "Collection not found", "code": "NOT_FOUND"},
		})
		return
	}

	// Rename physical folder on disk (skip for VIRTUAL_ALBUM)
	if collection.AlbumType != "VIRTUAL_ALBUM" {
		// Check if destination folder already exists
		newPath := h.organizer.AlbumFolderAbsPath(collection, req.AlbumDate, req.NewAlbumName)
		if _, err := os.Stat(newPath); err == nil {
			c.JSON(http.StatusConflict, gin.H{
				"error": gin.H{"message": "Destination folder already exists", "code": "FOLDER_EXISTS"},
			})
			return
		}

		if err := h.organizer.RenameAlbumFolder(collection, req.AlbumDate, req.CurrAlbumName, req.AlbumDate, req.NewAlbumName); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": gin.H{"message": "Failed to rename folder: " + err.Error(), "code": "RENAME_FAILED"},
			})
			return
		}
	}

	// Update DB records
	if err := h.albumsDB.UpdateAlbumName(req.CollectionID, req.AlbumDate, req.CurrAlbumName, req.NewAlbumName); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	c.Status(http.StatusOK)
}

// searchForExistingAlbums searches for albums matching a query string.
func (h *Handler) searchForExistingAlbums(c *gin.Context) {
	searchStr := c.Query("searchStr")
	if searchStr == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "searchStr query parameter is required", "code": "VALIDATION_ERROR"},
		})
		return
	}

	var collectionID *int64
	if cidStr := c.Query("collection_id"); cidStr != "" {
		cid, err := strconv.ParseInt(cidStr, 10, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": gin.H{"message": "Invalid collection_id", "code": "VALIDATION_ERROR"},
			})
			return
		}
		collectionID = &cid
	}

	// Get placeholder text from the collection if collection_id is provided
	var placeholder *string
	if collectionID != nil {
		col, err := h.collectionsDB.Get(*collectionID)
		if err == nil && col != nil && col.PlaceholderAlbumText != nil {
			placeholder = col.PlaceholderAlbumText
		}
	}

	results, err := h.albumsDB.SearchForExisting(searchStr, collectionID, placeholder)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	if results == nil {
		results = []AlbumSearchResult{}
	}

	c.JSON(http.StatusOK, results)
}
