// Package upload implements the UI file-upload feature: browser clients create
// an upload session (a random staging dir under the collection's
// ui_intake_upload_path), stream files into it one at a time, then finalize to
// hand the dir to the normal intake flow.
//
// Session state (sessionID -> dir + collection) is single-instance, process-
// wide mutable state, so it lives in package-level vars guarded by a mutex (per
// the project's "no boilerplate classes" rule). Handlers register via a
// package-level RegisterRoutes.
package upload

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/collections"
	"photo-loka/internal/indexing"
)

// uploadLogger resolves the current default handler at call time (mirrors the
// pattern used elsewhere, e.g. indexing.idxLogger).
func uploadLogger() *slog.Logger { return slog.Default().With("component", "upload") }

// session holds the staging dir and owning collection for an in-progress upload.
type session struct {
	collectionID int64
	dir          string
}

// Upload sessions are a single process-wide registry: sessionID -> session.
var (
	sessions   = make(map[string]*session)
	sessionsMu sync.Mutex
)

// RegisterRoutes mounts the upload endpoints on an authenticated (non-admin)
// group: regular users may upload into collections that have uploads enabled.
func RegisterRoutes(rg *gin.RouterGroup) {
	rg.POST("/createUploadSession", createUploadSession)
	rg.POST("/uploadFile", uploadFile)
	rg.POST("/finalizeUpload", finalizeUpload)
}

// newSessionID returns a random opaque session identifier. The client only
// ever handles this token; it never sees the real filesystem path.
func newSessionID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// createUploadSession validates the collection has an upload staging path and
// creates a fresh random dir under it. POST /createUploadSession {collection_id}
func createUploadSession(c *gin.Context) {
	var body struct {
		CollectionID int64 `json:"collection_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid request body: " + err.Error(),
			"code":    "INVALID_BODY",
		}})
		return
	}

	col, err := collections.Get(body.CollectionID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": err.Error(), "code": "INTERNAL_ERROR",
		}})
		return
	}
	if col == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
			"message": "collection not found", "code": "NOT_FOUND",
		}})
		return
	}

	if col.UIIntakeUploadPath == nil || *col.UIIntakeUploadPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "uploads are not enabled for this collection",
			"code":    "UPLOADS_DISABLED",
		}})
		return
	}

	basePath := *col.UIIntakeUploadPath

	sessionID, err := newSessionID()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to create session id", "code": "INTERNAL_ERROR",
		}})
		return
	}

	// Create a random per-session dir under the staging base. MkdirTemp picks a
	// unique name with the given prefix, so sessions never collide on disk.
	dir, err := os.MkdirTemp(basePath, "upload-")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to create staging directory: " + err.Error(),
			"code":    "INTERNAL_ERROR",
		}})
		return
	}

	sessionsMu.Lock()
	sessions[sessionID] = &session{collectionID: body.CollectionID, dir: dir}
	sessionsMu.Unlock()

	uploadLogger().Info("upload session created",
		"collection_id", body.CollectionID,
		"session_id", sessionID,
		"dir", dir,
	)

	c.JSON(http.StatusCreated, gin.H{"session_id": sessionID})
}

// uploadFile streams one file into the session's staging dir.
// POST /uploadFile?session_id=... (multipart form, field "file")
func uploadFile(c *gin.Context) {
	sessionID := c.Query("session_id")
	if sessionID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "session_id is required", "code": "MISSING_PARAMETER",
		}})
		return
	}

	sessionsMu.Lock()
	sess, ok := sessions[sessionID]
	sessionsMu.Unlock()
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
			"message": "upload session not found", "code": "SESSION_NOT_FOUND",
		}})
		return
	}

	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "no file in request: " + err.Error(), "code": "INVALID_BODY",
		}})
		return
	}

	// Use only the basename of the client-supplied filename to prevent path
	// traversal: the file must land inside the session dir, never above it.
	baseName := filepath.Base(filepath.FromSlash(fileHeader.Filename))
	if baseName == "" || baseName == "." || baseName == string(filepath.Separator) {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid filename", "code": "INVALID_FILENAME",
		}})
		return
	}

	destPath := resolveNameCollision(filepath.Join(sess.dir, baseName))

	src, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to read uploaded file: " + err.Error(),
			"code":    "INTERNAL_ERROR",
		}})
		return
	}
	defer src.Close()

	dst, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to create destination file: " + err.Error(),
			"code":    "INTERNAL_ERROR",
		}})
		return
	}

	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		os.Remove(destPath) // don't leave a partial file behind
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to write file: " + err.Error(),
			"code":    "INTERNAL_ERROR",
		}})
		return
	}
	if err := dst.Close(); err != nil {
		os.Remove(destPath)
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to finalize file: " + err.Error(),
			"code":    "INTERNAL_ERROR",
		}})
		return
	}

	c.Status(http.StatusCreated)
}

// finalizeUpload hands the session's staging dir to the intake flow and
// forgets the session. POST /finalizeUpload {session_id}
func finalizeUpload(c *gin.Context) {
	var body struct {
		SessionID string `json:"session_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid request body: " + err.Error(), "code": "INVALID_BODY",
		}})
		return
	}

	sessionsMu.Lock()
	sess, ok := sessions[body.SessionID]
	if ok {
		delete(sessions, body.SessionID)
	}
	sessionsMu.Unlock()
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
			"message": "upload session not found", "code": "SESSION_NOT_FOUND",
		}})
		return
	}

	// Run intake asynchronously (mirrors the existing intake handler). staleDays
	// 0 means "enqueue everything" so freshly-uploaded files are picked up
	// immediately rather than waiting for them to go stale.
	go func() {
		if err := indexing.StartIntakeFileIndexing(sess.collectionID, sess.dir, 0); err != nil {
			uploadLogger().Error("intake for uploaded files failed",
				"collection_id", sess.collectionID,
				"dir", sess.dir,
				"error", err,
			)
		}
	}()

	uploadLogger().Info("upload finalized, intake started",
		"collection_id", sess.collectionID,
		"dir", sess.dir,
	)

	c.Status(http.StatusAccepted)
}

// resolveNameCollision appends a counter suffix if the target path already
// exists, so two uploaded files with the same name don't clobber each other.
func resolveNameCollision(targetPath string) string {
	if _, err := os.Stat(targetPath); os.IsNotExist(err) {
		return targetPath
	}

	ext := filepath.Ext(targetPath)
	base := targetPath[:len(targetPath)-len(ext)]

	for i := 1; i < 10000; i++ {
		candidate := fmt.Sprintf("%s_%d%s", base, i, ext)
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}
	return fmt.Sprintf("%s_overflow%s", base, ext)
}
