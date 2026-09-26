package indexing

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/config"
)

// RegisterRoutes registers all indexer-related admin routes. The indexing
// queues and thumbnails dir are wired via Init at startup.
func RegisterRoutes(rg *gin.RouterGroup) {
	rg.POST("/startIndexingFirstTime", startIndexingFirstTime)
	rg.POST("/scanForChanges/:collection_id", scanForChanges)
	rg.POST("/startIntakeFileIndexing", startIntakeFileIndexing)
	rg.GET("/getIndexerStatus", getIndexerStatus)
	rg.PUT("/pauseIndexer", pauseIndexer)
	rg.PUT("/resumeIndexer", resumeIndexer)
	rg.GET("/getIndexerErrors", getIndexerErrors)
	rg.PUT("/updateIndexerConcurrency/:concurrency", updateIndexerConcurrency)
	rg.POST("/refreshMetadataForCollection/:collection_id", refreshMetadataForCollection)
	rg.POST("/refreshMetadataForItem/:uuid", refreshMetadataForItem)
}

// startIndexingFirstTime begins initial indexing for a collection.
// POST /startIndexingFirstTime?collection_id=N
func startIndexingFirstTime(c *gin.Context) {
	collectionIDStr := c.Query("collection_id")
	collectionID, err := strconv.ParseInt(collectionIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid collection_id parameter",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	go func() {
		if err := InitialIndexing(collectionID); err != nil {
			idxLogger().Error("initial indexing failed",
				"collection_id", collectionID,
				"error", err,
			)
		}
	}()

	c.Status(http.StatusAccepted)
}

// scanForChanges scans for file changes and enqueues new/modified files.
// POST /scanForChanges/:collection_id
func scanForChanges(c *gin.Context) {
	collectionIDStr := c.Param("collection_id")
	collectionID, err := strconv.ParseInt(collectionIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid collection_id",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	go func() {
		if err := ScanForChanges(collectionID); err != nil {
			idxLogger().Error("scan for changes failed",
				"collection_id", collectionID,
				"error", err,
			)
		}
	}()

	c.Status(http.StatusAccepted)
}

// startIntakeFileIndexing begins intake indexing for a directory.
// POST /startIntakeFileIndexing (body: {collection_id, dir, stale_days})
func startIntakeFileIndexing(c *gin.Context) {
	var body struct {
		CollectionID *int64  `json:"collection_id"`
		Dir          *string `json:"dir"`
		StaleDays    int     `json:"staleDays"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid request body: " + err.Error(),
			"code":    "INVALID_BODY",
		}})
		return
	}

	if body.CollectionID == nil && body.Dir == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "either collection_id or dir must be provided",
			"code":    "MISSING_PARAMETER",
		}})
		return
	}

	go func() {
		var err error
		if body.CollectionID != nil && body.Dir != nil {
			// Mode 1: specific dir in specific collection
			err = StartIntakeFileIndexing(*body.CollectionID, *body.Dir, body.StaleDays)
		} else if body.Dir != nil {
			// Mode 2: auto-find collection by intake path
			err = StartIntakeByDir(*body.Dir, body.StaleDays)
		} else {
			// Mode 3: all scheduled intake paths for collection
			err = StartIntakeForCollection(*body.CollectionID, body.StaleDays)
		}
		if err != nil {
			idxLogger().Error("intake file indexing failed", "error", err)
		}
	}()

	c.Status(http.StatusAccepted)
}

// getIndexerStatus returns an aggregate pipeline status snapshot.
// GET /getIndexerStatus
//
// NOTE: legacy shape retained during the pipeline transition. Phase 5 of the
// pipeline design replaces this with per-stage /api/admin/pipeline/status.
func getIndexerStatus(c *gin.Context) {
	if PipelineStatus == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{
			"message": "pipeline not initialized",
			"code":    "NOT_READY",
		}})
		return
	}
	c.JSON(http.StatusOK, PipelineStatus())
}

// pauseIndexer pauses all pipeline stages.
// PUT /pauseIndexer
func pauseIndexer(c *gin.Context) {
	if PipelinePause != nil {
		PipelinePause()
	}
	c.Status(http.StatusOK)
}

// resumeIndexer resumes all pipeline stages.
// PUT /resumeIndexer
func resumeIndexer(c *gin.Context) {
	if PipelineResume != nil {
		PipelineResume()
	}
	c.Status(http.StatusOK)
}

// getIndexerErrors returns recent errors aggregated across pipeline stages.
// GET /getIndexerErrors
func getIndexerErrors(c *gin.Context) {
	if PipelineErrors == nil {
		c.JSON(http.StatusOK, []interface{}{})
		return
	}
	c.JSON(http.StatusOK, PipelineErrors())
}

// updateIndexerConcurrency changes the entry-stage (bring-to-collection) concurrency.
// PUT /updateIndexerConcurrency/:concurrency
func updateIndexerConcurrency(c *gin.Context) {
	concurrencyStr := c.Param("concurrency")
	concurrency, err := strconv.Atoi(concurrencyStr)
	if err != nil || concurrency < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid concurrency value, must be a positive integer",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	if PipelineSetConcurrency != nil {
		PipelineSetConcurrency(concurrency)
	}

	// Persist to runtime config so it survives restart
	if err := config.Runtime.SetMaxConcurrency(concurrency); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "concurrency updated but failed to persist: " + err.Error(),
			"code":    "PERSIST_ERROR",
		}})
		return
	}

	c.Status(http.StatusOK)
}

// refreshMetadataForCollection re-extracts metadata for all files in a collection.
// POST /refreshMetadataForCollection/:collection_id
func refreshMetadataForCollection(c *gin.Context) {
	collectionIDStr := c.Param("collection_id")
	collectionID, err := strconv.ParseInt(collectionIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid collection_id",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	go func() {
		if err := RefreshMetadataForCollection(collectionID); err != nil {
			idxLogger().Error("refresh metadata for collection failed",
				"collection_id", collectionID,
				"error", err,
			)
		}
	}()

	c.Status(http.StatusAccepted)
}

// refreshMetadataForItem re-extracts metadata for a single item.
// POST /refreshMetadataForItem/:uuid
func refreshMetadataForItem(c *gin.Context) {
	itemUUID := c.Param("uuid")
	if itemUUID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "uuid is required",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	filename, err := GetFileName(itemUUID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
			"message": "item not found: " + err.Error(),
			"code":    "NOT_FOUND",
		}})
		return
	}

	go func() {
		if err := RefreshMetadata(itemUUID, filename); err != nil {
			idxLogger().Error("refresh metadata for item failed",
				"uuid", itemUUID,
				"error", err,
			)
		}
	}()

	c.Status(http.StatusAccepted)
}
