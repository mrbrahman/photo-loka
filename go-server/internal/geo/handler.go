package geo

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// RegisterRoutes registers geo-related routes on the given router group.
func RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/getReverseGeoEncodingStatus", getStatus)
	rg.POST("/enqueueReverseGeoEncoding", enqueueOne)
	rg.POST("/enqueueManyReverseGeoEncoding", enqueueMany)
}

// getStatus returns the current geo queue status.
func getStatus(c *gin.Context) {
	status := Status()
	high, normal, low := QueueSizes()

	c.JSON(http.StatusOK, gin.H{
		"processingCnt":  status.Active,
		"pendingCnt":     status.Pending,
		"completedCnt":   status.Completed,
		"failedCnt":      status.Failed,
		"paused":         status.IsPaused,
		"maxConcurrency": status.MaxConcurrency,
		"queueSizes": gin.H{
			"high":   high,
			"normal": normal,
			"low":    low,
		},
	})
}

// enqueueOne enqueues a single geo resolution task.
func enqueueOne(c *gin.Context) {
	var body struct {
		UUID string `json:"uuid" binding:"required"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"message": "uuid is required"}})
		return
	}

	Enqueue(body.UUID, nil)
	c.Status(http.StatusAccepted)
}

// enqueueMany enqueues multiple geo resolution tasks.
func enqueueMany(c *gin.Context) {
	var entries []map[string]interface{}

	if err := c.ShouldBindJSON(&entries); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"message": "expected array of objects with uuid, gps_lat, gps_lng, country_code"}})
		return
	}

	EnqueueMany(entries)
	c.Status(http.StatusAccepted)
}
