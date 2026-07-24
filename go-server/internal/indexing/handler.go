package indexing

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/queue"
)

// Handler provides HTTP route handlers for indexing operations.
type Handler struct {
	indexer    *Indexer
	indexQueue *queue.Queue
	videoQueue *queue.Queue
}

// NewHandler creates a new indexing Handler.
func NewHandler(indexer *Indexer, indexQueue, videoQueue *queue.Queue) *Handler {
	return &Handler{
		indexer:    indexer,
		indexQueue: indexQueue,
		videoQueue: videoQueue,
	}
}

// RegisterRoutes registers all indexer-related admin routes.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup) {
	rg.POST("/startIndexingFirstTime", h.startIndexingFirstTime)
	rg.POST("/scanForChanges/:collection_id", h.scanForChanges)
	rg.POST("/startIntakeFileIndexing", h.startIntakeFileIndexing)
	rg.GET("/getIndexerStatus", h.getIndexerStatus)
	rg.PUT("/pauseIndexer", h.pauseIndexer)
	rg.PUT("/resumeIndexer", h.resumeIndexer)
	rg.GET("/getIndexerErrors", h.getIndexerErrors)
	rg.PUT("/updateIndexerConcurrency/:concurrency", h.updateIndexerConcurrency)
	rg.POST("/refreshMetadataForCollection/:collection_id", h.refreshMetadataForCollection)
	rg.POST("/refreshMetadataForItem/:uuid", h.refreshMetadataForItem)
}

// startIndexingFirstTime begins initial indexing for a collection.
// POST /startIndexingFirstTime?collection_id=N
func (h *Handler) startIndexingFirstTime(c *gin.Context) {
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
		if err := h.indexer.InitialIndexing(collectionID); err != nil {
			h.indexer.logger.Error("initial indexing failed",
				"collection_id", collectionID,
				"error", err,
			)
		}
	}()

	c.JSON(http.StatusAccepted, gin.H{"message": "indexing started", "collection_id": collectionID})
}

// scanForChanges scans for file changes and enqueues new/modified files.
// POST /scanForChanges/:collection_id
func (h *Handler) scanForChanges(c *gin.Context) {
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
		if err := h.indexer.ScanForChanges(collectionID); err != nil {
			h.indexer.logger.Error("scan for changes failed",
				"collection_id", collectionID,
				"error", err,
			)
		}
	}()

	c.JSON(http.StatusAccepted, gin.H{"message": "scan started", "collection_id": collectionID})
}

// startIntakeFileIndexing begins intake indexing for a directory.
// POST /startIntakeFileIndexing (body: {collection_id, dir, stale_days})
func (h *Handler) startIntakeFileIndexing(c *gin.Context) {
	var body struct {
		CollectionID int64  `json:"collection_id" binding:"required"`
		Dir          string `json:"dir" binding:"required"`
		StaleDays    int    `json:"staleDays"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid request body: " + err.Error(),
			"code":    "INVALID_BODY",
		}})
		return
	}

	if body.StaleDays <= 0 {
		body.StaleDays = 1
	}

	go func() {
		if err := h.indexer.StartIntakeFileIndexing(body.CollectionID, body.Dir, body.StaleDays); err != nil {
			h.indexer.logger.Error("intake file indexing failed",
				"collection_id", body.CollectionID,
				"dir", body.Dir,
				"error", err,
			)
		}
	}()

	c.JSON(http.StatusAccepted, gin.H{
		"message":       "intake indexing started",
		"collection_id": body.CollectionID,
		"dir":           body.Dir,
	})
}

// getIndexerStatus returns the current status of both queues.
// GET /getIndexerStatus
func (h *Handler) getIndexerStatus(c *gin.Context) {
	indexStatus := h.indexQueue.GetStatus()
	videoStatus := h.videoQueue.GetStatus()

	c.JSON(http.StatusOK, gin.H{
		"processingCnt": indexStatus.Active + videoStatus.Active,
		"pendingCnt":    indexStatus.Pending + videoStatus.Pending,
		"completedCnt":  indexStatus.Completed + videoStatus.Completed,
		"failedCnt":     indexStatus.Failed + videoStatus.Failed,
		"paused":        indexStatus.IsPaused,
		"maxConcurrency": indexStatus.MaxConcurrency,
		"queueSizes": gin.H{
			"high":   0, // tracked within indexQueue internally
			"normal": indexStatus.Pending,
			"low":    videoStatus.Pending,
		},
	})
}

// pauseIndexer pauses the index queue.
// PUT /pauseIndexer
func (h *Handler) pauseIndexer(c *gin.Context) {
	h.indexQueue.Pause()
	c.JSON(http.StatusOK, gin.H{"message": "indexer paused"})
}

// resumeIndexer resumes the index queue.
// PUT /resumeIndexer
func (h *Handler) resumeIndexer(c *gin.Context) {
	h.indexQueue.Resume()
	c.JSON(http.StatusOK, gin.H{"message": "indexer resumed"})
}

// getIndexerErrors returns recent errors from both queues.
// GET /getIndexerErrors
func (h *Handler) getIndexerErrors(c *gin.Context) {
	indexErrors := h.indexQueue.GetErrors()
	videoErrors := h.videoQueue.GetErrors()

	allErrors := append(indexErrors, videoErrors...)
	c.JSON(http.StatusOK, allErrors)
}

// updateIndexerConcurrency changes the max concurrency of the index queue.
// PUT /updateIndexerConcurrency/:concurrency
func (h *Handler) updateIndexerConcurrency(c *gin.Context) {
	concurrencyStr := c.Param("concurrency")
	concurrency, err := strconv.Atoi(concurrencyStr)
	if err != nil || concurrency < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid concurrency value, must be a positive integer",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	h.indexQueue.SetConcurrency(concurrency)
	c.JSON(http.StatusOK, gin.H{"message": "concurrency updated", "max_concurrency": concurrency})
}

// refreshMetadataForCollection re-extracts metadata for all files in a collection.
// POST /refreshMetadataForCollection/:collection_id
func (h *Handler) refreshMetadataForCollection(c *gin.Context) {
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
		if err := h.indexer.RefreshMetadataForCollection(collectionID); err != nil {
			h.indexer.logger.Error("refresh metadata for collection failed",
				"collection_id", collectionID,
				"error", err,
			)
		}
	}()

	c.JSON(http.StatusAccepted, gin.H{"message": "metadata refresh started", "collection_id": collectionID})
}

// refreshMetadataForItem re-extracts metadata for a single item.
// POST /refreshMetadataForItem/:uuid
func (h *Handler) refreshMetadataForItem(c *gin.Context) {
	itemUUID := c.Param("uuid")
	if itemUUID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "uuid is required",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	filename, err := h.indexer.db.GetFileName(itemUUID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
			"message": "item not found: " + err.Error(),
			"code":    "NOT_FOUND",
		}})
		return
	}

	go func() {
		if err := h.indexer.RefreshMetadata(itemUUID, filename); err != nil {
			h.indexer.logger.Error("refresh metadata for item failed",
				"uuid", itemUUID,
				"error", err,
			)
		}
	}()

	c.JSON(http.StatusAccepted, gin.H{"message": "metadata refresh started", "uuid": itemUUID})
}
