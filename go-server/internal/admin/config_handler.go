package admin

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/config"
)

// ConfigHandler handles runtime configuration endpoints.
type ConfigHandler struct {
	rtConfig *config.RuntimeConfig
}

// NewConfigHandler creates a new ConfigHandler.
func NewConfigHandler(rtConfig *config.RuntimeConfig) *ConfigHandler {
	return &ConfigHandler{rtConfig: rtConfig}
}

// RegisterRoutes registers config management routes on the given router group.
func (h *ConfigHandler) RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/getConfig", h.getConfig)
	rg.PUT("/updateConfig", h.updateConfig)
}

// getConfig returns the current runtime configuration.
// GET /api/admin/getConfig
func (h *ConfigHandler) getConfig(c *gin.Context) {
	c.JSON(http.StatusOK, h.rtConfig)
}

// updateConfig updates a single runtime config field.
// PUT /api/admin/updateConfig
func (h *ConfigHandler) updateConfig(c *gin.Context) {
	var body struct {
		Key   string      `json:"key" binding:"required"`
		Value interface{} `json:"value"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"message": "Invalid request body: key is required",
				"code":    "INVALID_REQUEST",
			},
		})
		return
	}

	if err := h.rtConfig.Update(body.Key, body.Value); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"message": err.Error(),
				"code":    "CONFIG_UPDATE_FAILED",
			},
		})
		return
	}

	// Return the actual stored value (after type conversion) rather than the raw input
	storedValue, _ := h.rtConfig.Get(body.Key)
	c.JSON(http.StatusOK, gin.H{
		"key":   body.Key,
		"value": storedValue,
	})
}
