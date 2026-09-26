package pipeline

import (
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
