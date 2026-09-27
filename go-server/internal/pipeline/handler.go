package pipeline

import (
	"io"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// RegisterRoutes mounts the per-stage pipeline admin endpoints under
// /pipeline on the given (admin) router group:
//
//	GET  /pipeline/status                          - per-stage status snapshot
//	PUT  /pipeline/stages/:name/concurrency/:n     - set a stage's concurrency
//	PUT  /pipeline/stages/:name/pause              - pause a stage
//	PUT  /pipeline/stages/:name/resume             - resume a stage
//
// Handlers operate on the package singleton P (wired by Init at startup).
func RegisterRoutes(rg *gin.RouterGroup) {
	g := rg.Group("/pipeline")
	g.GET("/status", getStatus)
	g.GET("/config", getConfig)
	g.PUT("/config", putConfig)
	g.POST("/config/validate", validateConfig)
	g.PUT("/stages/:name/concurrency/:n", setStageConcurrency)
	g.PUT("/stages/:name/pause", pauseStage)
	g.PUT("/stages/:name/resume", resumeStage)
}

// notReady writes a 503 when the pipeline has not been initialized.
func notReady(c *gin.Context) {
	c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{
		"message": "pipeline not initialized", "code": "NOT_READY",
	}})
}

// unknownStage writes a 404 for an unrecognized stage name.
func unknownStage(c *gin.Context, name string) {
	c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
		"message": "unknown pipeline stage: " + name, "code": "UNKNOWN_STAGE",
	}})
}

// getStatus returns a per-stage status snapshot.
// GET /api/admin/pipeline/status
func getStatus(c *gin.Context) {
	if P == nil {
		notReady(c)
		return
	}
	c.JSON(http.StatusOK, gin.H{"stages": P.Status()})
}

// getConfig returns the current pipeline config JSON (concurrency/enable/gating).
// GET /api/admin/pipeline/config
func getConfig(c *gin.Context) {
	raw, err := GetConfigJSON()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to read pipeline config: " + err.Error(), "code": "CONFIG_READ_FAILED",
		}})
		return
	}
	c.Data(http.StatusOK, "application/json", raw)
}

// parseConfigBody reads the request body as pipeline config JSON, parses and
// validates it, and returns it. On any problem (empty body, parse error, or
// validation failure) it writes the appropriate 400 response and returns
// ok=false. Shared by putConfig and validateConfig.
func parseConfigBody(c *gin.Context) (PipelineConfig, bool) {
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "failed to read request body: " + err.Error(), "code": "BAD_BODY",
		}})
		return PipelineConfig{}, false
	}
	if len(body) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "empty body: send the full pipeline config JSON", "code": "EMPTY_BODY",
		}})
		return PipelineConfig{}, false
	}
	// ParsePipelineConfig both unmarshals and validates (unknown/missing stage,
	// disabling a structural stage, unknown gatedBy, cyclic gate graph).
	cfg, err := ParsePipelineConfig(string(body))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": err.Error(), "code": "INVALID_CONFIG",
		}})
		return PipelineConfig{}, false
	}
	return cfg, true
}

// putConfig applies a whole new pipeline config to the running pipeline (live,
// no restart) and persists it. The body is the full config JSON. Invalid config
// (unknown/missing stage, disabling a structural stage, unknown gatedBy, or a
// cyclic gate graph) is rejected and the running pipeline is left unchanged.
// PUT /api/admin/pipeline/config
func putConfig(c *gin.Context) {
	if P == nil {
		notReady(c)
		return
	}
	cfg, ok := parseConfigBody(c)
	if !ok {
		return
	}
	if err := P.Apply(cfg); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to apply config: " + err.Error(), "code": "APPLY_FAILED",
		}})
		return
	}
	// Echo back the applied per-stage status so the caller sees the effect.
	c.JSON(http.StatusOK, gin.H{"stages": P.Status()})
}

// validateConfig checks a proposed pipeline config WITHOUT applying or
// persisting it -- for a UI to validate before committing. Returns 200
// {"valid": true} if it parses and validates, or 400 with the error otherwise.
// POST /api/admin/pipeline/config/validate
func validateConfig(c *gin.Context) {
	if _, ok := parseConfigBody(c); !ok {
		return // parseConfigBody already wrote the 400
	}
	c.JSON(http.StatusOK, gin.H{"valid": true})
}

// setStageConcurrency sets one stage's concurrency (live) and persists it to
// the pipeline config so it survives restart.
// PUT /api/admin/pipeline/stages/:name/concurrency/:n
func setStageConcurrency(c *gin.Context) {
	if P == nil {
		notReady(c)
		return
	}
	name := c.Param("name")
	n, err := strconv.Atoi(c.Param("n"))
	if err != nil || n < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "concurrency must be a positive integer", "code": "INVALID_PARAM",
		}})
		return
	}
	if !P.HasStage(name) {
		unknownStage(c, name)
		return
	}
	P.SetStageConcurrency(name, n)
	if err := persistStageConcurrency(name, n); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "concurrency applied but failed to persist: " + err.Error(),
			"code":    "PERSIST_ERROR",
		}})
		return
	}
	c.JSON(http.StatusOK, P.StageStatus(name))
}

// pauseStage pauses one stage's queue.
// PUT /api/admin/pipeline/stages/:name/pause
func pauseStage(c *gin.Context) {
	if P == nil {
		notReady(c)
		return
	}
	name := c.Param("name")
	if !P.PauseStage(name) {
		unknownStage(c, name)
		return
	}
	c.JSON(http.StatusOK, P.StageStatus(name))
}

// resumeStage resumes one stage's queue.
// PUT /api/admin/pipeline/stages/:name/resume
func resumeStage(c *gin.Context) {
	if P == nil {
		notReady(c)
		return
	}
	name := c.Param("name")
	if !P.ResumeStage(name) {
		unknownStage(c, name)
		return
	}
	c.JSON(http.StatusOK, P.StageStatus(name))
}
