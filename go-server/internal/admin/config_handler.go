package admin

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/config"
	"photo-loka/internal/pipeline"
)

// RegisterConfigRoutes registers config management routes on the given router group.
func RegisterConfigRoutes(rg *gin.RouterGroup) {
	rg.GET("/getConfig", getConfig)
	rg.PUT("/updateConfig", updateConfig)
}

// getConfig returns the current runtime configuration (flat scalar settings).
// The pipeline config (pipelineConfig) is a separate JSON blob that is not
// surfaced here yet -- there is no UI for editing it, and applying it without a
// restart is not implemented. It can still be read/written via updateConfig
// with key "pipelineConfig" when needed.
// GET /api/admin/getConfig
func getConfig(c *gin.Context) {
	c.JSON(http.StatusOK, config.Runtime)
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

	// Return the actual stored value. pipelineConfig lives outside RuntimeConfig,
	// so echo back its stored JSON; everything else comes from RuntimeConfig.Get.
	if body.Key == "pipelineConfig" {
		stored, _ := pipeline.GetConfigJSON()
		c.JSON(http.StatusOK, gin.H{"key": body.Key, "value": stored})
		return
	}
	storedValue, _ := config.Runtime.Get(body.Key)
	c.JSON(http.StatusOK, gin.H{
		"key":   body.Key,
		"value": storedValue,
	})
}

// dispatchConfigUpdate routes an untyped API value to the matching typed setter,
// validating the JSON type per key.
func dispatchConfigUpdate(key string, value interface{}) error {
	rc := config.Runtime
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
	case "pipelineConfig":
		// The value is a JSON object (stages array). Re-marshal it to text and
		// hand to the pipeline package to validate + persist. Takes effect on
		// restart (static apply; dynamic re-wire is a later enhancement).
		raw, err := json.Marshal(value)
		if err != nil {
			return fmt.Errorf("config key %q: cannot serialize value: %w", key, err)
		}
		return pipeline.SetConfigJSON(string(raw))
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
