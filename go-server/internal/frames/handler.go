package frames

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// Handler provides HTTP route handlers for frame operations.
type Handler struct {
	manager *Manager
}

// NewHandler creates a new frames Handler.
func NewHandler(manager *Manager) *Handler {
	return &Handler{manager: manager}
}

// RegisterPublicRoutes registers public (unauthenticated) frame routes.
func (h *Handler) RegisterPublicRoutes(rg *gin.RouterGroup) {
	frame := rg.Group("/frame")
	{
		frame.GET("/getNext", h.getNext)
		frame.GET("/getPrev", h.getPrev)
		frame.GET("/events", h.events)
	}
}

// RegisterAdminRoutes registers admin-only frame management routes.
func (h *Handler) RegisterAdminRoutes(rg *gin.RouterGroup) {
	rg.POST("/createNewFrame", h.createNewFrame)
	rg.POST("/loadAllFrames", h.loadAllFrames)
	rg.GET("/getAllFrames", h.getAllFrames)
	rg.PUT("/updateFrame/:frame_id", h.updateFrame)
	rg.DELETE("/deleteFrame/:frame_id", h.deleteFrame)
	rg.POST("/pauseFrame/:frame_id", h.pauseFrame)
	rg.POST("/resumeFrame/:frame_id", h.resumeFrame)
}

// getNext returns the next item for the requesting frame.
// GET /frame/getNext
func (h *Handler) getNext(c *gin.Context) {
	ip := extractClientIP(c)

	item, err := h.manager.GetNextItem(ip)
	if err != nil {
		if errors.Is(err, ErrFramePaused) {
			c.JSON(http.StatusLocked, gin.H{"error": gin.H{
				"message": "Frame is paused",
				"code":    "FRAME_PAUSED",
			}})
			return
		}
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
			"message": err.Error(),
			"code":    "FRAME_NOT_FOUND",
		}})
		return
	}

	if item == nil {
		c.JSON(http.StatusOK, nil)
		return
	}

	c.JSON(http.StatusOK, item)
}

// getPrev returns the previous item for the requesting frame.
// GET /frame/getPrev
func (h *Handler) getPrev(c *gin.Context) {
	ip := extractClientIP(c)

	item, err := h.manager.GetPrevItem(ip)
	if err != nil {
		if errors.Is(err, ErrFramePaused) {
			c.JSON(http.StatusLocked, gin.H{"error": gin.H{
				"message": "Frame is paused",
				"code":    "FRAME_PAUSED",
			}})
			return
		}
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
			"message": err.Error(),
			"code":    "FRAME_NOT_FOUND",
		}})
		return
	}

	if item == nil {
		c.JSON(http.StatusOK, nil)
		return
	}

	c.JSON(http.StatusOK, item)
}

// events is the SSE endpoint for frame push notifications.
// GET /frame/events
func (h *Handler) events(c *gin.Context) {
	ip := extractClientIP(c)

	// Set SSE headers
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")

	// Register SSE client
	ch := h.manager.RegisterSSEClient(ip)
	defer h.manager.UnregisterSSEClient(ip)

	// Flush headers
	c.Writer.Flush()

	// Send initial connected event
	io.WriteString(c.Writer, "data: {\"type\":\"connected\"}\n\n")
	c.Writer.Flush()

	clientGone := c.Request.Context().Done()

	for {
		select {
		case <-clientGone:
			return
		case event, ok := <-ch:
			if !ok {
				return
			}
			// Write SSE event (Node.js format: unnamed event with type in JSON payload)
			_, err := io.WriteString(c.Writer, fmt.Sprintf("data: {\"type\":\"%s\"}\n\n", event))
			if err != nil {
				return
			}
			c.Writer.Flush()
		}
	}
}

// createNewFrame creates a new frame.
// POST /createNewFrame
func (h *Handler) createNewFrame(c *gin.Context) {
	var frame Frame
	if err := c.ShouldBindJSON(&frame); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid request body: " + err.Error(),
			"code":    "INVALID_BODY",
		}})
		return
	}

	id, err := h.manager.CreateFrame(&frame)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": err.Error(),
			"code":    "CREATE_FAILED",
		}})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"frame_id": id})
}

// loadAllFrames reloads all frames from DB and reinitializes state.
// POST /loadAllFrames
func (h *Handler) loadAllFrames(c *gin.Context) {
	if err := h.manager.LoadAllFrames(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": err.Error(),
			"code":    "LOAD_FAILED",
		}})
		return
	}

	// Re-schedule cron jobs to match the reloaded frame set.
	h.manager.ScheduleAllFrameJobs()

	c.Status(http.StatusOK)
}

// getAllFrames returns all frames with their in-memory state.
// GET /getAllFrames
func (h *Handler) getAllFrames(c *gin.Context) {
	frames, err := h.manager.GetAllFrames()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": err.Error(),
			"code":    "QUERY_FAILED",
		}})
		return
	}

	c.JSON(http.StatusOK, frames)
}

// updateFrame updates an existing frame.
// PUT /updateFrame/:frame_id
func (h *Handler) updateFrame(c *gin.Context) {
	frameID, err := strconv.ParseInt(c.Param("frame_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid frame_id",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	var frame Frame
	if err := c.ShouldBindJSON(&frame); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid request body: " + err.Error(),
			"code":    "INVALID_BODY",
		}})
		return
	}

	if err := h.manager.UpdateFrame(frameID, &frame); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": err.Error(),
			"code":    "UPDATE_FAILED",
		}})
		return
	}

	c.Status(http.StatusOK)
}

// deleteFrame removes a frame.
// DELETE /deleteFrame/:frame_id
func (h *Handler) deleteFrame(c *gin.Context) {
	frameID, err := strconv.ParseInt(c.Param("frame_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid frame_id",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	if err := h.manager.DeleteFrame(frameID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": err.Error(),
			"code":    "DELETE_FAILED",
		}})
		return
	}

	c.Status(http.StatusOK)
}

// pauseFrame manually pauses a frame.
// POST /pauseFrame/:frame_id
func (h *Handler) pauseFrame(c *gin.Context) {
	frameID, err := strconv.ParseInt(c.Param("frame_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid frame_id",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	var body struct {
		ResumeAtSchedule *bool `json:"resumeAtSchedule"`
	}
	// Body is optional
	_ = c.ShouldBindJSON(&body)

	if err := h.manager.PauseFrame(frameID, body.ResumeAtSchedule); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": err.Error(),
			"code":    "PAUSE_FAILED",
		}})
		return
	}

	c.Status(http.StatusOK)
}

// resumeFrame manually resumes a frame.
// POST /resumeFrame/:frame_id
func (h *Handler) resumeFrame(c *gin.Context) {
	frameID, err := strconv.ParseInt(c.Param("frame_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid frame_id",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	if err := h.manager.ResumeFrame(frameID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": err.Error(),
			"code":    "RESUME_FAILED",
		}})
		return
	}

	c.Status(http.StatusOK)
}

// extractClientIP gets the client IP from the request, stripping port if present.
func extractClientIP(c *gin.Context) string {
	ip := c.ClientIP()
	// Strip port if present (e.g. from X-Forwarded-For with port)
	if idx := strings.LastIndex(ip, ":"); idx > 0 {
		// Only strip if it looks like ip:port (not IPv6)
		if !strings.Contains(ip, "[") {
			ip = ip[:idx]
		}
	}
	return ip
}
