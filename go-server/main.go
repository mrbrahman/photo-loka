package main

import (
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/lmittmann/tint"

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
	"photo-loka/internal/jobs"
	"photo-loka/internal/media"
	"photo-loka/internal/ml"
	"photo-loka/internal/queue"
	"photo-loka/internal/scheduler"
	"photo-loka/internal/search"
	"photo-loka/internal/server"
)

const banner = `
 ____  _           _          _          _         
|  _ \| |__   ___ | |_ ___   | |    ___ | | ____ _ 
| |_) | '_ \ / _ \| __/ _ \  | |   / _ \| |/ / _` + "`" + ` |
|  __/| | | | (_) | || (_) | | |__| (_) |   < (_| |
|_|   |_| |_|\___/ \__\___/  |_____\___/|_|\_\__,_|
                                           Go Server
`

// version is set at build time via -ldflags "-X main.version=..."
var version = "dev"

func main() {
	// Determine subcommand
	subcommand := "serve"
	if len(os.Args) > 1 {
		arg := os.Args[1]
		if arg == "-h" || arg == "--help" || arg == "help" {
			printHelp()
			os.Exit(0)
		}
		if arg == "-v" || arg == "--version" {
			fmt.Printf("photo-loka %s\n", version)
			os.Exit(0)
		}
		if arg[0] != '-' {
			subcommand = arg
		}
	}

	switch subcommand {
	case "serve":
		runServe()
	case "create-user":
		runCreateUser()
	case "unlock-user":
		runUnlockUser()
	case "generate-token":
		runGenerateToken()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", subcommand)
		fmt.Fprintf(os.Stderr, "Run 'photo-loka --help' for usage.\n")
		os.Exit(1)
	}
}

func printHelp() {
	help := `Photo-Loka Go Server %s

Usage: photo-loka [command]

Commands:
  serve            Start the web server (default if no command given)
  create-user      Create a new user account
  unlock-user      Unlock a locked user account
  generate-token   Generate a long-lived API token
  help             Show this help message

Subcommand usage:
  photo-loka create-user --username <name> --password <pass> --role admin|user
  photo-loka unlock-user --username <name>
  photo-loka generate-token <username> [days]

Environment variables (required):
  DATA_DIR             Absolute path to the data directory (stores DB, thumbnails, faces)
  JWT_SECRET           Secret key for signing JWT tokens
  GEONAMES_USERNAME    Username for geonames.org API (reverse geocoding)

Environment variables (optional):
  PORT                 HTTP port (default: 9000)
  ML_SERVICE_URL       ML service base URL (default: http://localhost:8000)
  INDEXER_MODE         Indexer concurrency mode: 'static' or 'dynamic' (default: static)
  LOG_LEVEL            Log level: debug, info, warn, error (default: info)
  NO_COLOR             Disable colored log output (set to any value)

Getting started:
  1. Create a .env file (or export the variables above)
  2. Start the server:       ./photo-loka
  3. Create an admin user:   ./photo-loka create-user --username admin --password <pass> --role admin
  4. Visit http://localhost:9000

External dependencies:
  ffmpeg       Required for video thumbnail extraction and compression
  exiftool     Required for metadata read/write (v12.78+ recommended for geolocation)
  libvips      Shared library required at runtime for image operations and HEIC
               support (linked dynamically via govips; e.g. apt install libvips42t64)
`
	fmt.Printf(help, version)
}

func runServe() {
	// Init logging
	initLogging()

	fmt.Print(banner)
	fmt.Printf("                                           %s\n\n", version)

	// Preflight: validate config and dependencies together
	preflightCheck()

	// Load startup config
	cfg, err := config.LoadStartupConfig()
	if err != nil {
		slog.Error("failed to load startup config", "error", err)
		os.Exit(1)
	}

	if os.Getenv("ML_SERVICE_URL") == "" {
		slog.Info("ML_SERVICE_URL not set, using default", "url", cfg.MLServiceURL)
	}

	// Load runtime config
	rtCfg, err := config.LoadRuntimeConfig(cfg.DataDir)
	if err != nil {
		slog.Error("failed to load runtime config", "error", err)
		os.Exit(1)
	}

	// Check if ML service is reachable
	checkMLService(cfg.MLServiceURL)

	// Initialize libvips for image processing
	if err := media.InitVips(); err != nil {
		slog.Error("failed to initialize libvips; ensure the libvips shared library is installed (e.g. apt install libvips42t64)",
			"error", err)
		os.Exit(1)
	}
	slog.Info("libvips initialized", "version", media.VipsVersion())
	defer media.ShutdownVips()

	// Initialize persistent exiftool process
	if err := media.InitExiftool(); err != nil {
		slog.Error("failed to initialize exiftool", "error", err)
		os.Exit(1)
	}
	defer media.CloseExiftool()

	// Open database
	db, err := database.Open(cfg.DBFile)
	if err != nil {
		slog.Error("failed to open database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	// Create auth service
	authDB := auth.NewAuthDB(db.Conn)
	authSvc := auth.NewService(authDB, cfg.JWTSecret)

	// Create collections service and handler
	collectionsDB := collections.NewCollectionsDB(db.Conn)
	collectionsSvc := collections.NewService(collectionsDB)
	collectionsHandler := collections.NewHandler(collectionsSvc)

	// Create albums DB (handler created after organizer below)
	albumsDB := albums.NewAlbumsDB(db.Conn)

	// Create search handler
	searchDB := search.NewSearchDB(db.Conn)
	mlClient := ml.NewClient(cfg.MLServiceURL)
	searchHandler := search.NewHandler(searchDB, collectionsDB, albumsDB, mlClient)

	// Create media handler
	mediaHandler := media.NewHandler(cfg.ThumbsDir, cfg.FacesDir, db.Conn)

	// Create dashboard handler
	dashboardHandler := dashboard.NewHandler(db.Conn)

	// Create indexing queues
	numCPU := runtime.NumCPU()
	indexConcurrency := numCPU - 1
	if indexConcurrency < 1 {
		indexConcurrency = 1
	}
	indexQueue := queue.New(indexConcurrency)
	videoQueue := queue.New(2)

	// Apply maxConcurrency from runtime config if set
	if rtCfg.MaxConcurrency > 0 {
		indexQueue.SetConcurrency(rtCfg.MaxConcurrency)
	}

	// Create indexing components
	indexingDB := indexing.NewIndexingDB(db.Conn)
	organizer := indexing.NewOrganizer(indexingDB, rtCfg)
	albumsHandler := albums.NewHandler(albumsDB, collectionsDB, organizer)
	indexer := indexing.NewIndexer(indexingDB, organizer, indexQueue, videoQueue, cfg.ThumbsDir, rtCfg, collectionsDB)
	indexingHandler := indexing.NewHandler(indexer, indexQueue, videoQueue, rtCfg)

	// Create geo components
	geoQueue := queue.New(1) // geo runs single-threaded due to rate limits
	geoDB := geo.NewGeoDB(db.Conn)
	rateLimitStateFile := filepath.Join(cfg.DataDir, "rate_limit_state.json")
	rateLimiter := geo.NewRateLimiter(rtCfg, rateLimitStateFile)
	geoFinalizer := geo.NewFinalizer(geoDB, rateLimiter, cfg.GeonamesUsername)
	geoService := geo.NewService(geoFinalizer, geoQueue)
	geoHandler := geo.NewHandler(geoService)

	// Create ML components
	mlDB := ml.NewMLDB(db.Conn)
	mlService := ml.NewService(mlClient, mlDB, cfg.FacesDir)
	mlHandler := ml.NewHandler(mlService)

	// Wire geo and ML services into the indexer for post-indexing enrichments
	indexer.SetGeoService(geoService)
	indexer.SetMLService(mlService)

	// Create items handler
	itemsHandler := items.NewHandler(indexer, organizer, mlService, collectionsDB, rtCfg, cfg.ThumbsDir)

	// Scheduler
	sched := scheduler.New()

	// Frames
	framesDB := frames.NewFramesDB(db.Conn)
	frameManager := frames.NewManager(framesDB, searchDB, sched)
	framesHandler := frames.NewHandler(frameManager)

	// Jobs
	fileWatcher := jobs.NewFileWatcher(indexer, collectionsDB)
	scheduledIndexing := jobs.NewScheduledIndexing(sched, indexer, collectionsDB)

	// Wire collection change callback to restart watchers/cron
	collectionsHandler.OnCollectionChanged = func(collectionID int64) {
		col, err := collectionsDB.Get(collectionID)
		if err != nil || col == nil {
			return
		}
		fileWatcher.StopForCollection(collectionID)
		scheduledIndexing.StopForCollection(collectionID)
		fileWatcher.StartForCollection(col)
		scheduledIndexing.ScheduleForCollection(col)
	}

	// Admin handlers
	configHandler := admin.NewConfigHandler(rtCfg)
	usersHandler := admin.NewUsersHandler(authSvc)
	jobsHandler := admin.NewJobsHandler(sched, fileWatcher, scheduledIndexing, collectionsDB, frameManager)

	// Authn handler
	authnHandler := authn.NewHandler(authSvc)

	// Determine web assets filesystem: use ../web on disk if present, else embedded
	var webFS http.FileSystem
	if _, err := os.Stat("../web"); err == nil {
		webFS = http.Dir("../web")
		slog.Info("serving web assets from filesystem", "path", "../web")
	} else if webEmbedded {
		subFS, _ := fs.Sub(embeddedWeb, "web")
		webFS = http.FS(subFS)
		slog.Info("serving web assets from embedded binary")
	} else {
		slog.Error("web assets not found: ../web directory missing and binary was not built with embedded assets")
		os.Exit(1)
	}

	// Create and run server
	srv := server.New(cfg, db, authSvc,
		collectionsHandler,
		albumsHandler,
		searchHandler,
		mediaHandler,
		dashboardHandler,
		indexingHandler,
		geoHandler,
		mlHandler,
		itemsHandler,
		framesHandler,
		configHandler,
		usersHandler,
		jobsHandler,
		authnHandler,
		frameManager,
		webFS,
	)

	slog.Info("starting Photo-Loka", "port", cfg.Port, "data_dir", cfg.DataDir)

	// Startup activities
	if rtCfg.StartFileWatcherAtStartup {
		if err := fileWatcher.StartForAllCollections(); err != nil {
			slog.Error("failed to start file watchers", "error", err)
		}
	} else {
		// Mark immediate intakes as stopped in DB when watchers are disabled
		collectionsDB.SetIntakeStatusByMethod("immediate", "stopped")
		slog.Info("file watcher at startup disabled - marked immediate intakes as stopped")
	}
	if rtCfg.StartScheduledIndexingAtStartup {
		if err := scheduledIndexing.ScheduleAll(); err != nil {
			slog.Error("failed to schedule intake indexing", "error", err)
		}
	} else {
		// Mark scheduled intakes as stopped in DB when scheduling is disabled
		collectionsDB.SetIntakeStatusByMethod("scheduled", "stopped")
		slog.Info("scheduled indexing at startup disabled - marked scheduled intakes as stopped")
	}
	if rtCfg.ScanFilesForChangesAndIndexAtStartup {
		go func() {
			cols, err := collectionsDB.GetAll()
			if err != nil {
				slog.Error("failed to get collections for scan", "error", err)
				return
			}
			for _, col := range cols {
				if err := indexer.ScanForChanges(col.CollectionID); err != nil {
					slog.Error("scan for changes failed", "collection_id", col.CollectionID, "error", err)
				}
			}
		}()
	}
	if err := frameManager.LoadAllFrames(); err != nil {
		slog.Error("failed to load frames", "error", err)
	}

	// Schedule frame cron jobs (reset, pause/resume)
	frameManager.ScheduleAllFrameJobs()

	// Schedule token cleanup (daily at 3am)
	sched.AddJob("token-cleanup", "0 3 * * *", func() {
		authSvc.CleanupExpiredTokens()
	})

	if err := srv.Run(); err != nil {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}

	// Shutdown activities
	sched.Stop()
	fileWatcher.StopAll()
	scheduledIndexing.StopAll()
	rateLimiter.Save() // persist rate limit counters for next startup
	indexQueue.Stop()
	videoQueue.Stop()
	geoQueue.Stop()
}

func runCreateUser() {
	fs := flag.NewFlagSet("create-user", flag.ExitOnError)
	username := fs.String("username", "", "Username (required)")
	password := fs.String("password", "", "Password (required)")
	role := fs.String("role", "user", "Role: admin or user")

	args := os.Args[2:] // skip binary name and subcommand
	if err := fs.Parse(args); err != nil {
		os.Exit(1)
	}

	if *username == "" || *password == "" {
		fmt.Fprintf(os.Stderr, "Error: --username and --password are required\n")
		fs.Usage()
		os.Exit(1)
	}

	if *role != "admin" && *role != "user" {
		fmt.Fprintf(os.Stderr, "Error: --role must be 'admin' or 'user'\n")
		os.Exit(1)
	}

	authSvc := initAuthService()
	defer closeDB(authSvc)

	userID, err := authSvc.CreateUser(*username, *password, *role)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating user: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("User created successfully: %s (id=%d, role=%s)\n", *username, userID, *role)
}

func runUnlockUser() {
	fs := flag.NewFlagSet("unlock-user", flag.ExitOnError)
	username := fs.String("username", "", "Username to unlock (required)")

	args := os.Args[2:]
	if err := fs.Parse(args); err != nil {
		os.Exit(1)
	}

	if *username == "" {
		fmt.Fprintf(os.Stderr, "Error: --username is required\n")
		fs.Usage()
		os.Exit(1)
	}

	authSvc := initAuthService()
	defer closeDB(authSvc)

	if err := authSvc.UnlockUser(*username); err != nil {
		fmt.Fprintf(os.Stderr, "Error unlocking user: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("User %s unlocked successfully\n", *username)
}

func runGenerateToken() {
	args := os.Args[2:]
	if len(args) < 1 {
		fmt.Fprintf(os.Stderr, "Usage: photo-loka generate-token USERNAME [DAYS]\n")
		os.Exit(1)
	}

	username := args[0]
	days := 365 // default 1 year
	if len(args) > 1 {
		d, err := strconv.Atoi(args[1])
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: invalid DAYS value %q\n", args[1])
			os.Exit(1)
		}
		days = d
	}

	authSvc := initAuthService()
	defer closeDB(authSvc)

	token, err := authSvc.GenerateAPIToken(username, days)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error generating token: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("API token for %s (expires in %d days):\n\n%s\n", username, days, token)
}

// initAuthService loads config, opens DB, and returns an auth Service for CLI commands.
// Caller is responsible for calling closeDB.
func initAuthService() *auth.Service {
	cfg, err := config.LoadStartupConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
		os.Exit(1)
	}

	db, err := database.Open(cfg.DBFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error opening database: %v\n", err)
		os.Exit(1)
	}

	// Store db reference for cleanup
	cliDB = db

	authDB := auth.NewAuthDB(db.Conn)
	return auth.NewService(authDB, cfg.JWTSecret)
}

// cliDB holds a reference to the database for CLI cleanup.
var cliDB *database.DB

func closeDB(_ *auth.Service) {
	if cliDB != nil {
		cliDB.Close()
	}
}

// checkMLService pings the ML service health endpoint and warns if it's not reachable.
func checkMLService(mlServiceURL string) {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(mlServiceURL + "/health")
	if err != nil {
		slog.Warn("ML service is not reachable; face recognition and AI search will not work", "url", mlServiceURL)
		return
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		slog.Warn("ML service returned unhealthy status", "url", mlServiceURL, "status", resp.StatusCode)
		return
	}
	slog.Info("ML service is healthy", "url", mlServiceURL)
}

// initLogging sets up structured logging with tint handler.
func initLogging() {
	// If running under systemd (INVOCATION_ID set), skip timestamps
	_, underSystemd := os.LookupEnv("INVOCATION_ID")

	opts := &tint.Options{
		Level:      slog.LevelInfo,
		TimeFormat: time.DateTime,
		NoColor:    os.Getenv("NO_COLOR") != "",
	}

	if underSystemd {
		opts.TimeFormat = "" // No timestamp when systemd provides it
	}

	handler := tint.NewHandler(os.Stderr, opts)
	slog.SetDefault(slog.New(handler))
}

// preflightCheck validates all prerequisites (env vars + external tools) in one pass.
// Reports all issues together so the user can fix everything at once.
func preflightCheck() {
	var problems []string

	// Check required environment variables
	_, err := config.LoadStartupConfig()
	if err != nil {
		if envErr, ok := err.(*config.MissingEnvError); ok {
			for _, v := range envErr.Vars {
				problems = append(problems, fmt.Sprintf("  - Missing environment variable: %s", v))
			}
		} else {
			problems = append(problems, fmt.Sprintf("  - Config error: %s", err))
		}
	}

	// Check required external tools
	deps := []struct {
		name     string
		checkCmd string
		help     string
	}{
		{"ffmpeg", "ffmpeg", "apt install ffmpeg / dnf install ffmpeg / brew install ffmpeg"},
		{"exiftool", "exiftool", "https://exiftool.org"},
	}

	for _, dep := range deps {
		_, err := exec.LookPath(dep.checkCmd)
		if err != nil {
			problems = append(problems, fmt.Sprintf("  - Missing external tool: %s (install from %s)", dep.name, dep.help))
		}
	}

	if len(problems) > 0 {
		fmt.Fprintf(os.Stderr, "\nCannot start server. The following issues were found:\n\n")
		for _, p := range problems {
			fmt.Fprintf(os.Stderr, "%s\n", p)
		}
		fmt.Fprintf(os.Stderr, "\nRun './photo-loka --help' for full configuration details.\n\n")
		os.Exit(1)
	}

	// Exiftool version check (non-fatal, just a warning)
	out, err := exec.Command("exiftool", "-ver").Output()
	if err == nil {
		version := strings.TrimSpace(string(out))
		parts := strings.Split(version, ".")
		if len(parts) >= 2 {
			major := 0
			minor := 0
			fmt.Sscanf(parts[0], "%d", &major)
			fmt.Sscanf(parts[1], "%d", &minor)
			if major < 12 || (major == 12 && minor < 78) {
				slog.Warn("exiftool version is below 12.78; geolocation features (timezone resolution from GPS, reverse geocoding via exiftool) will not be available",
					"installed", version,
					"recommended", "12.78+",
					"install_latest", "https://exiftool.org",
				)
			}
		}
	}
}
