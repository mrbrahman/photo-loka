package search

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/albums"
	"photo-loka/internal/collections"
	"photo-loka/internal/ml"
)

// Handler provides HTTP handlers for search operations.
type Handler struct {
	searchDB      *SearchDB
	collectionsDB *collections.CollectionsDB
	albumsDB      *albums.AlbumsDB
	mlClient      *ml.Client
}

// NewHandler creates a new search Handler.
func NewHandler(searchDB *SearchDB, collectionsDB *collections.CollectionsDB, albumsDB *albums.AlbumsDB, mlClient *ml.Client) *Handler {
	return &Handler{
		searchDB:      searchDB,
		collectionsDB: collectionsDB,
		albumsDB:      albumsDB,
		mlClient:      mlClient,
	}
}

// RegisterRoutes registers search routes on the given router group.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/getAll", h.getAll)
	rg.POST("/search", h.search)
	rg.GET("/getItemInfo", h.getItemInfo)
	rg.GET("/getGpsCoordinates", h.getGpsCoordinates)
	rg.GET("/searchForExistingAlbums", h.searchForExistingAlbums)
	rg.POST("/searchByGpsCoordinates", h.searchByGpsCoordinates)
	rg.GET("/getTrashedItems", h.getTrashedItems)
}

// getAll returns all items within a date range (default: last 365 days), grouped by day.
func (h *Handler) getAll(c *gin.Context) {
	cidStr := c.Query("collection_id")
	if cidStr == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "collection_id is required", "code": "VALIDATION_ERROR"},
		})
		return
	}
	cid, err := strconv.ParseInt(cidStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Invalid collection_id", "code": "VALIDATION_ERROR"},
		})
		return
	}
	collectionID := &cid

	// Default date range: last 365 days
	now := time.Now()
	toDate := c.DefaultQuery("to", now.Format("2006-01-02"))
	fromDate := c.DefaultQuery("from", now.AddDate(-1, 0, 0).Format("2006-01-02"))

	dateRange := &DateRange{
		FromDate: fromDate,
		ToDate:   toDate,
	}

	results, err := h.searchDB.RunSearch(collectionID, "", false, true, "", dateRange)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	c.JSON(http.StatusOK, results)
}

// searchRequest is the request body for the search endpoint.
type searchRequest struct {
	CollectionID *int64 `json:"collection_id"`
	SearchText   string `json:"searchText"`
}

// aiSearchRe matches the ai:"query" search prefix.
var aiSearchRe = regexp.MustCompile(`(?i)^ai:"?(.+?)"?$`)

// search runs a full-text search query.
func (h *Handler) search(c *gin.Context) {
	var req searchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Invalid request body: " + err.Error(), "code": "VALIDATION_ERROR"},
		})
		return
	}

	if req.SearchText == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "searchText is required", "code": "VALIDATION_ERROR"},
		})
		return
	}

	// Check for AI semantic search prefix
	searchText := strings.TrimSpace(req.SearchText)
	if matches := aiSearchRe.FindStringSubmatch(searchText); matches != nil {
		aiQuery := matches[1]
		h.handleAISearch(c, req.CollectionID, aiQuery)
		return
	}

	results, err := h.searchDB.RunSearch(req.CollectionID, req.SearchText, false, true, "", nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	c.JSON(http.StatusOK, results)
}

// handleAISearch performs semantic search via the ML service.
func (h *Handler) handleAISearch(c *gin.Context, collectionID *int64, query string) {
	if h.mlClient == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": gin.H{"message": "ML service not configured", "code": "ML_UNAVAILABLE"},
		})
		return
	}

	result, err := h.mlClient.SearchByText(query)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": "AI search failed: " + err.Error(), "code": "ML_ERROR"},
		})
		return
	}

	// Extract UUIDs from ML response
	var uuids []string
	if results, ok := result["results"].([]interface{}); ok {
		for _, r := range results {
			if m, ok := r.(map[string]interface{}); ok {
				if id, ok := m["image_id"].(string); ok {
					uuids = append(uuids, id)
				}
			}
		}
	}

	if len(uuids) == 0 {
		c.JSON(http.StatusOK, []interface{}{})
		return
	}

	// Build a raw filter to search by the returned UUIDs
	quoted := make([]string, len(uuids))
	for i, u := range uuids {
		quoted[i] = "'" + u + "'"
	}
	rawFilter := `raw:"uuid in (` + strings.Join(quoted, ",") + `)"`

	results, err := h.searchDB.RunSearch(collectionID, rawFilter, false, true, "", nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	c.JSON(http.StatusOK, results)
}

// getItemInfo returns full metadata for a single item.
func (h *Handler) getItemInfo(c *gin.Context) {
	uuid := c.Query("uuid")
	if uuid == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "uuid query parameter is required", "code": "VALIDATION_ERROR"},
		})
		return
	}

	info, err := h.searchDB.GetItemInfo(uuid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	if info == nil {
		c.JSON(http.StatusNotFound, gin.H{
			"error": gin.H{"message": "Item not found", "code": "NOT_FOUND"},
		})
		return
	}

	c.JSON(http.StatusOK, info)
}

// getGpsCoordinates returns rounded GPS coordinates for map display.
func (h *Handler) getGpsCoordinates(c *gin.Context) {
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

	results, err := h.searchDB.GetGpsCoordinates(collectionID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	c.JSON(http.StatusOK, results)
}

// searchForExistingAlbums searches for existing albums by name.
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
		results = []albums.AlbumSearchResult{}
	}

	c.JSON(http.StatusOK, results)
}

// searchByGpsRequest is the request body for GPS-based search.
type searchByGpsRequest struct {
	CollectionID *int64 `json:"collection_id"`
	Bounds       struct {
		SW struct {
			Lat float64 `json:"lat"`
			Lng float64 `json:"lng"`
		} `json:"sw"`
		NE struct {
			Lat float64 `json:"lat"`
			Lng float64 `json:"lng"`
		} `json:"ne"`
	} `json:"bounds"`
}

// searchByGpsCoordinates searches for items within GPS bounding box.
func (h *Handler) searchByGpsCoordinates(c *gin.Context) {
	var req searchByGpsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Invalid request body: " + err.Error(), "code": "VALIDATION_ERROR"},
		})
		return
	}

	results, err := h.searchDB.SearchByGps(
		req.CollectionID,
		req.Bounds.SW.Lat, req.Bounds.SW.Lng,
		req.Bounds.NE.Lat, req.Bounds.NE.Lng,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	c.JSON(http.StatusOK, results)
}

// getTrashedItems returns all trashed items for a collection.
func (h *Handler) getTrashedItems(c *gin.Context) {
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

	results, err := h.searchDB.RunSearch(collectionID, "", true, true, "", nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	c.JSON(http.StatusOK, results)
}
