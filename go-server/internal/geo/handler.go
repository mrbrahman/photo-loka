package geo

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// Handler provides HTTP route handlers for geo encoding operations.
type Handler struct {
	service *Service
}

// NewHandler creates a new geo Handler.
func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// RegisterRoutes registers geo-related routes on the given router group.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/getReverseGeoEncodingStatus", h.getStatus)
	rg.POST("/enqueueReverseGeoEncoding", h.enqueueOne)
	rg.POST("/enqueueManyReverseGeoEncoding", h.enqueueMany)
}

// getStatus returns the current geo queue status.
func (h *Handler) getStatus(c *gin.Context) {
	status := h.service.Status()
	c.JSON(http.StatusOK, status)
}

// enqueueOne enqueues a single geo resolution task.
func (h *Handler) enqueueOne(c *gin.Context) {
	var body struct {
		UUID string `json:"uuid" binding:"required"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"message": "uuid is required"}})
		return
	}

	h.service.Enqueue(body.UUID, nil)
	c.JSON(http.StatusOK, gin.H{"message": "enqueued"})
}

// enqueueMany enqueues multiple geo resolution tasks.
func (h *Handler) enqueueMany(c *gin.Context) {
	var entries []map[string]interface{}

	if err := c.ShouldBindJSON(&entries); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"message": "expected array of objects with uuid, gps_lat, gps_lng, country_code"}})
		return
	}

	h.service.EnqueueMany(entries)
	c.JSON(http.StatusOK, gin.H{"message": "enqueued", "count": len(entries)})
}
