package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/admin"
	"photo-loka/internal/albums"
	"photo-loka/internal/auth"
	"photo-loka/internal/authn"
	"photo-loka/internal/collections"
	"photo-loka/internal/config"
	"photo-loka/internal/dashboard"
	"photo-loka/internal/frames"
	"photo-loka/internal/geo"
	"photo-loka/internal/indexing"
	"photo-loka/internal/items"
	"photo-loka/internal/jobs"
	"photo-loka/internal/media"
	"photo-loka/internal/ml"
	"photo-loka/internal/queue"
	"photo-loka/internal/scheduler"
	"photo-loka/internal/search"
)

// Package-level engine and startup config, set by Setup. The HTTP layer is a
// process-wide singleton, so there is no Server struct: Setup builds the engine
// and mounts routes; Run serves it.
var (
	router *gin.Engine
	cfg    *config.StartupConfig
)

// Deps bundles the application collaborators that the route packages need.
// Handlers are now package-level (their routes are registered via each
// package's RegisterRoutes function), so the server just threads these
// collaborators through to those registration calls. Services that collapsed
// to package-level singletons (auth, collections, geo, ml) are initialized in
// main and are not threaded here.
type Deps struct {
	FrameIPChecker auth.FrameIPChecker
	Organizer      *indexing.Organizer
	Indexer        *indexing.Indexer
	IndexQueue     *queue.Queue
	VideoQueue     *queue.Queue
	FrameManager   *frames.Manager
	Scheduler      *scheduler.Scheduler
	FileWatcher    *jobs.FileWatcher
	ScheduledIdx   *jobs.ScheduledIndexing
	ThumbsDir      string
	FacesDir       string
}

// Setup builds the Gin engine, installs middleware, and mounts all routes.
func Setup(startupCfg *config.StartupConfig, deps Deps, webFS http.FileSystem) {
	cfg = startupCfg

	gin.SetMode(gin.ReleaseMode)

	router = gin.New()
	router.Use(gin.Recovery())

	// Request logging middleware (skip thumbnail requests)
	router.Use(requestLogger())

	// Serve static files with Cache-Control: no-cache
	router.Use(staticFileHandler(webFS))

	setupRoutes(deps)
}

// setupRoutes mounts all route groups.
func setupRoutes(deps Deps) {
	// Health and ping
	router.GET("/ping", func(c *gin.Context) {
		c.Status(http.StatusNoContent)
	})
	router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// Public auth routes (no auth required)
	authnGroup := router.Group("/api/authn")
	authn.RegisterRoutes(authnGroup)

	// Public frame routes (no auth required)
	frames.RegisterPublicRoutes(&router.RouterGroup, deps.FrameManager)

	// Public API routes (authenticated but non-admin)
	publicAPI := router.Group("/api")
	publicAPI.Use(auth.AuthMiddleware())
	{
		// Collections summary (non-admin)
		collections.RegisterPublicRoutes(publicAPI)
	}

	// Authenticated routes
	apiGroup := router.Group("/api")
	apiGroup.Use(auth.AuthMiddleware())
	{
		search.RegisterRoutes(apiGroup)
		albums.RegisterRoutes(apiGroup, deps.Organizer)
		items.RegisterRoutes(apiGroup, deps.Organizer, deps.ThumbsDir)
		geo.RegisterRoutes(apiGroup)
		ml.RegisterRoutes(apiGroup)
	}

	// Media routes (with frame IP bypass)
	mediaGroup := router.Group("/api")
	mediaGroup.Use(auth.MediaAuthMiddleware(deps.FrameIPChecker))
	{
		media.RegisterRoutes(mediaGroup, deps.ThumbsDir, deps.FacesDir)
	}

	// Admin routes
	adminGroup := router.Group("/api/admin")
	adminGroup.Use(auth.AuthMiddleware())
	adminGroup.Use(auth.AdminMiddleware())
	{
		collections.RegisterAdminRoutes(adminGroup)
		dashboard.RegisterRoutes(adminGroup)
		indexing.RegisterRoutes(adminGroup, deps.Indexer, deps.IndexQueue, deps.VideoQueue)
		frames.RegisterAdminRoutes(adminGroup, deps.FrameManager)
		admin.RegisterConfigRoutes(adminGroup)
		admin.RegisterUsersRoutes(adminGroup)
		admin.RegisterJobsRoutes(adminGroup, deps.Scheduler, deps.FileWatcher, deps.ScheduledIdx, deps.FrameManager)
	}
}

// Run starts the HTTP server with graceful shutdown.
func Run() error {
	addr := fmt.Sprintf(":%d", cfg.Port)

	srv := &http.Server{
		Addr:    addr,
		Handler: router,
	}

	// Channel to listen for interrupt signals
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	// Start server in goroutine
	errCh := make(chan error, 1)
	go func() {
		slog.Info("server started", "port", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	// Wait for interrupt or server error
	select {
	case <-quit:
		slog.Info("shutting down server...")
	case err := <-errCh:
		return fmt.Errorf("server error: %w", err)
	}

	// Graceful shutdown with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		return fmt.Errorf("server forced to shutdown: %w", err)
	}

	slog.Info("server stopped")
	return nil
}

// maxBodyLogSize is the maximum number of bytes to capture from the request body for logging.
const maxBodyLogSize = 2048

// requestLogger is a Gin middleware that logs requests, skipping thumbnail/static requests.
func requestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Skip logging for static files, thumbnails, and media serving
		path := c.Request.URL.Path

		// Skip all static web assets
		if strings.HasPrefix(path, "/js/") ||
			strings.HasPrefix(path, "/css/") ||
			strings.HasPrefix(path, "/assets/") ||
			strings.Contains(path, "/getThumbnail") ||
			strings.Contains(path, "/getFaceThumbnail") ||
			strings.HasSuffix(path, ".html") ||
			strings.HasSuffix(path, ".mjs") ||
			strings.HasSuffix(path, ".json") ||
			strings.HasSuffix(path, ".png") ||
			strings.HasSuffix(path, ".ico") ||
			strings.HasSuffix(path, ".woff2") ||
			path == "/" {
			c.Next()
			return
		}

		// Capture request body for methods that typically have one.
		// NOTE: In Go, http.Request.Body is a stream (io.ReadCloser) - once read, it's
		// consumed. We must read the full body into memory and restore it for downstream
		// handlers. This means every POST/PUT/PATCH body is fully buffered in memory by
		// this middleware (unlike the default behavior where it can be streamed/read
		// incrementally). If this becomes a concern (large payloads, memory pressure),
		// this body-logging block can be removed without affecting functionality.
		var bodyStr string
		if c.Request.Body != nil && (c.Request.Method == "POST" || c.Request.Method == "PUT" || c.Request.Method == "PATCH") {
			bodyBytes, _ := io.ReadAll(c.Request.Body)
			c.Request.Body.Close()
			// Restore the full body so downstream handlers can read it
			c.Request.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))
			if len(bodyBytes) > 0 {
				if len(bodyBytes) > maxBodyLogSize {
					bodyStr = string(bodyBytes[:maxBodyLogSize]) + "...(truncated)"
				} else {
					bodyStr = string(bodyBytes)
				}
			}
		}

		start := time.Now()
		c.Next()
		duration := time.Since(start)

		status := c.Writer.Status()
		level := slog.LevelInfo
		if status >= 400 {
			level = slog.LevelWarn
		}
		if status >= 500 {
			level = slog.LevelError
		}

		// Include username if available (set by auth middleware)
		username, _ := c.Get("username")
		usernameStr, _ := username.(string)

		attrs := []any{}
		if usernameStr != "" {
			attrs = append(attrs, "user", usernameStr)
		}
		attrs = append(attrs,
			"method", c.Request.Method,
			"path", path,
		)
		if c.Request.URL.RawQuery != "" {
			attrs = append(attrs, "query", c.Request.URL.RawQuery)
		}
		if bodyStr != "" {
			attrs = append(attrs, "body", bodyStr)
		}
		attrs = append(attrs,
			"status", status,
			"duration", duration.String(),
		)

		slog.Log(context.Background(), level, "request", attrs...)
	}
}

// staticFileHandler serves static files from the provided filesystem.
func staticFileHandler(fs http.FileSystem) gin.HandlerFunc {
	fileServer := http.FileServer(fs)

	return func(c *gin.Context) {
		urlPath := c.Request.URL.Path

		// Only serve static files for non-API paths
		if strings.HasPrefix(urlPath, "/api") || urlPath == "/ping" || urlPath == "/health" {
			c.Next()
			return
		}

		// Check if the file exists before attempting to serve
		f, err := fs.Open(urlPath)
		if err != nil {
			// File not found - let other handlers deal with it
			c.Next()
			return
		}
		f.Close()

		// Set Cache-Control header and serve
		c.Header("Cache-Control", "no-cache")
		fileServer.ServeHTTP(c.Writer, c.Request)
		c.Abort()
	}
}
