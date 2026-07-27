package server

import (
	"context"
	"fmt"
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
	"photo-loka/internal/database"
	"photo-loka/internal/frames"
	"photo-loka/internal/geo"
	"photo-loka/internal/indexing"
	"photo-loka/internal/items"
	"photo-loka/internal/media"
	"photo-loka/internal/ml"
	"photo-loka/internal/search"
)

// Server holds the Gin engine and application dependencies.
type Server struct {
	Router             *gin.Engine
	Config             *config.StartupConfig
	DB                 *database.DB
	AuthService        *auth.Service
	FrameIPChecker     auth.FrameIPChecker
	CollectionsHandler *collections.Handler
	AlbumsHandler      *albums.Handler
	SearchHandler      *search.Handler
	MediaHandler       *media.Handler
	DashboardHandler   *dashboard.Handler
	IndexingHandler    *indexing.Handler
	GeoHandler         *geo.Handler
	MLHandler          *ml.Handler
	ItemsHandler       *items.Handler
	FramesHandler      *frames.Handler
	ConfigHandler      *admin.ConfigHandler
	UsersHandler       *admin.UsersHandler
	JobsHandler        *admin.JobsHandler
	AuthnHandler       *authn.Handler
}

// New creates a configured Server with all routes and middleware.
func New(cfg *config.StartupConfig, db *database.DB, authSvc *auth.Service,
	collectionsHandler *collections.Handler,
	albumsHandler *albums.Handler,
	searchHandler *search.Handler,
	mediaHandler *media.Handler,
	dashboardHandler *dashboard.Handler,
	indexingHandler *indexing.Handler,
	geoHandler *geo.Handler,
	mlHandler *ml.Handler,
	itemsHandler *items.Handler,
	framesHandler *frames.Handler,
	configHandler *admin.ConfigHandler,
	usersHandler *admin.UsersHandler,
	jobsHandler *admin.JobsHandler,
	authnHandler *authn.Handler,
	frameIPChecker auth.FrameIPChecker,
) *Server {
	gin.SetMode(gin.ReleaseMode)

	router := gin.New()
	router.Use(gin.Recovery())

	// Request logging middleware (skip thumbnail requests)
	router.Use(requestLogger())

	// Serve static files from ../web with Cache-Control: no-cache
	router.Use(staticFileHandler())

	s := &Server{
		Router:             router,
		Config:             cfg,
		DB:                 db,
		AuthService:        authSvc,
		FrameIPChecker:     frameIPChecker,
		CollectionsHandler: collectionsHandler,
		AlbumsHandler:      albumsHandler,
		SearchHandler:      searchHandler,
		MediaHandler:       mediaHandler,
		DashboardHandler:   dashboardHandler,
		IndexingHandler:    indexingHandler,
		GeoHandler:         geoHandler,
		MLHandler:          mlHandler,
		ItemsHandler:       itemsHandler,
		FramesHandler:      framesHandler,
		ConfigHandler:      configHandler,
		UsersHandler:       usersHandler,
		JobsHandler:        jobsHandler,
		AuthnHandler:       authnHandler,
	}

	s.setupRoutes()

	return s
}

// setupRoutes mounts all route groups.
func (s *Server) setupRoutes() {
	// Health and ping
	s.Router.GET("/ping", func(c *gin.Context) {
		c.Status(http.StatusNoContent)
	})
	s.Router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// Public auth routes (no auth required)
	authnGroup := s.Router.Group("/api/authn")
	s.AuthnHandler.RegisterRoutes(authnGroup)

	// Public frame routes (no auth required)
	s.FramesHandler.RegisterPublicRoutes(&s.Router.RouterGroup)

	// Public API routes (authenticated but non-admin)
	publicAPI := s.Router.Group("/api")
	publicAPI.Use(auth.AuthMiddleware(s.AuthService))
	{
		// Collections summary (non-admin)
		s.CollectionsHandler.RegisterPublicRoutes(publicAPI)
	}

	// Authenticated routes
	apiGroup := s.Router.Group("/api")
	apiGroup.Use(auth.AuthMiddleware(s.AuthService))
	{
		s.SearchHandler.RegisterRoutes(apiGroup)
		s.AlbumsHandler.RegisterRoutes(apiGroup)
		s.ItemsHandler.RegisterRoutes(apiGroup)
		s.GeoHandler.RegisterRoutes(apiGroup)
		s.MLHandler.RegisterRoutes(apiGroup)
	}

	// Media routes (with frame IP bypass)
	mediaGroup := s.Router.Group("/api")
	mediaGroup.Use(auth.MediaAuthMiddleware(s.AuthService, s.FrameIPChecker))
	{
		s.MediaHandler.RegisterRoutes(mediaGroup)
	}

	// Admin routes
	adminGroup := s.Router.Group("/api/admin")
	adminGroup.Use(auth.AuthMiddleware(s.AuthService))
	adminGroup.Use(auth.AdminMiddleware())
	{
		s.CollectionsHandler.RegisterAdminRoutes(adminGroup)
		s.DashboardHandler.RegisterRoutes(adminGroup)
		s.IndexingHandler.RegisterRoutes(adminGroup)
		s.FramesHandler.RegisterAdminRoutes(adminGroup)
		s.ConfigHandler.RegisterRoutes(adminGroup)
		s.UsersHandler.RegisterRoutes(adminGroup)
		s.JobsHandler.RegisterRoutes(adminGroup)
	}
}

// Run starts the HTTP server with graceful shutdown.
func (s *Server) Run() error {
	addr := fmt.Sprintf(":%d", s.Config.Port)

	srv := &http.Server{
		Addr:    addr,
		Handler: s.Router,
	}

	// Channel to listen for interrupt signals
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	// Start server in goroutine
	errCh := make(chan error, 1)
	go func() {
		slog.Info("server started", "port", s.Config.Port)
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
			strings.HasSuffix(path, ".json") ||
			strings.HasSuffix(path, ".png") ||
			strings.HasSuffix(path, ".ico") ||
			strings.HasSuffix(path, ".woff2") ||
			path == "/" {
			c.Next()
			return
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
		attrs = append(attrs,
			"status", status,
			"duration", duration.String(),
		)

		slog.Log(context.Background(), level, "request", attrs...)
	}
}

// staticFileHandler serves static files from ../web directory.
func staticFileHandler() gin.HandlerFunc {
	fs := http.Dir("../web")
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
