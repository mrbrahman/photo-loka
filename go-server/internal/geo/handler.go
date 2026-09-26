package geo

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// RegisterRoutes registers geo-related routes on the given router group. The
// reverse-geo-encoding endpoints operate on the pipeline's geo-lookup stage via
// the EnqueueLookup / LookupStatus hooks (wired by pipeline.Init).
func RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/getReverseGeoEncodingStatus", getStatus)
	rg.POST("/enqueueReverseGeoEncoding", enqueueOne)
	rg.POST("/enqueueManyReverseGeoEncoding", enqueueMany)
}

// getStatus returns the geo-lookup stage's status.
func getStatus(c *gin.Context) {
	if LookupStatus == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{"message": "pipeline not initialized"}})
		return
	}
	c.JSON(http.StatusOK, LookupStatus())
}

// enqueueOne enqueues a single geo resolution on the geo-lookup stage. The
// stage self-hydrates GPS/country from the DB by uuid, so only the uuid is
// needed.
func enqueueOne(c *gin.Context) {
	var body struct {
		UUID string `json:"uuid" binding:"required"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"message": "uuid is required"}})
		return
	}

	if EnqueueLookup == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{"message": "pipeline not initialized"}})
		return
	}
	EnqueueLookup(body.UUID)
	c.Status(http.StatusAccepted)
}

// enqueueMany enqueues geo resolution for multiple uuids on the geo-lookup
// stage. Only the uuid of each entry is used; the stage derives the rest.
func enqueueMany(c *gin.Context) {
	var entries []map[string]interface{}

	if err := c.ShouldBindJSON(&entries); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"message": "expected array of objects with a uuid field"}})
		return
	}

	if EnqueueLookup == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{"message": "pipeline not initialized"}})
		return
	}
	for _, entry := range entries {
		if uuid, ok := entry["uuid"].(string); ok && uuid != "" {
			EnqueueLookup(uuid)
		}
	}
	c.Status(http.StatusAccepted)
}
