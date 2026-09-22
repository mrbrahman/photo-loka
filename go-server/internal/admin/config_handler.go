package admin

import (
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/config"
)

// RegisterConfigRoutes registers config management routes on the given router group.
func RegisterConfigRoutes(rg *gin.RouterGroup) {
	rg.GET("/getConfig", getConfig)
	rg.PUT("/updateConfig", updateConfig)
}

// getConfig returns the current runtime configuration.
// GET /api/admin/getConfig
func getConfig(c *gin.Context) {
	c.JSON(http.StatusOK, config.Rt)
}

// updateConfig updates a single runtime config field.
// PUT /api/admin/updateConfig
func updateConfig(c *gin.Context) {
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

	// Dispatch to the typed setter for the key. body.Value arrives from JSON as
	// interface{}, so JSON numbers are float64 and must be asserted/converted
	// here - the one honest coercion, at the HTTP edge.
	if err := dispatchConfigUpdate(body.Key, body.Value); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"message": err.Error(),
				"code":    "CONFIG_UPDATE_FAILED",
			},
		})
		return
	}

	// Return the actual stored value (after type conversion) rather than the raw input
	storedValue, _ := config.Rt.Get(body.Key)
	c.JSON(http.StatusOK, gin.H{
		"key":   body.Key,
		"value": storedValue,
	})
}

// dispatchConfigUpdate routes an untyped API value to the matching typed setter,
// validating the JSON type per key.
func dispatchConfigUpdate(key string, value interface{}) error {
	rc := config.Rt
	switch key {
	case "startFileWatcherAtStartup":
		b, err := asBool(key, value)
		if err != nil {
			return err
		}
		return rc.SetStartFileWatcherAtStartup(b)
	case "startScheduledIndexingAtStartup":
		b, err := asBool(key, value)
		if err != nil {
			return err
		}
		return rc.SetStartScheduledIndexingAtStartup(b)
	case "auditFiles":
		b, err := asBool(key, value)
		if err != nil {
			return err
		}
		return rc.SetAuditFiles(b)
	case "geonamesHourlyLimit":
		n, err := asInt(key, value)
		if err != nil {
			return err
		}
		return rc.SetGeonamesHourlyLimit(n)
	case "geonamesDailyLimit":
		n, err := asInt(key, value)
		if err != nil {
			return err
		}
		return rc.SetGeonamesDailyLimit(n)
	case "videoEncoder":
		s, err := asString(key, value)
		if err != nil {
			return err
		}
		return rc.SetVideoEncoder(s)
	case "maxConcurrency":
		n, err := asInt(key, value)
		if err != nil {
			return err
		}
		return rc.SetMaxConcurrency(n)
	case "performFaceRecognition":
		b, err := asBool(key, value)
		if err != nil {
			return err
		}
		return rc.SetPerformFaceRecognition(b)
	default:
		return fmt.Errorf("unknown config key: %q", key)
	}
}

// asBool/asInt/asString convert a JSON-decoded value to a concrete type,
// returning a clear error on mismatch. JSON numbers decode to float64.
func asBool(key string, v interface{}) (bool, error) {
	b, ok := v.(bool)
	if !ok {
		return false, fmt.Errorf("config key %q expects a boolean, got %T", key, v)
	}
	return b, nil
}

func asInt(key string, v interface{}) (int, error) {
	f, ok := v.(float64)
	if !ok {
		return 0, fmt.Errorf("config key %q expects a number, got %T", key, v)
	}
	return int(f), nil
}

func asString(key string, v interface{}) (string, error) {
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("config key %q expects a string, got %T", key, v)
	}
	return s, nil
}
