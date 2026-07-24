package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
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

func main() {
	// Determine subcommand
	subcommand := "serve"
	if len(os.Args) > 1 && os.Args[1][0] != '-' {
		subcommand = os.Args[1]
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
		fmt.Fprintf(os.Stderr, "Usage: photo-loka [serve|create-user|unlock-user|generate-token]\n")
		os.Exit(1)
	}
}

func runServe() {
	// Init logging
	initLogging()

	fmt.Print(banner)

	// Load startup config
	cfg, err := config.LoadStartupConfig()
	if err != nil {
		slog.Error("failed to load startup config", "error", err)
		os.Exit(1)
	}

	// Load runtime config
	rtCfg, err := config.LoadRuntimeConfig(cfg.DataDir)
	if err != nil {
		slog.Error("failed to load runtime config", "error", err)
		os.Exit(1)
	}

	// Initialize libvips for image processing
	media.InitVips()
	defer media.ShutdownVips()

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

	// Create albums handler
	albumsDB := albums.NewAlbumsDB(db.Conn)
	albumsHandler := albums.NewHandler(albumsDB, collectionsDB)

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
	indexer := indexing.NewIndexer(indexingDB, organizer, indexQueue, videoQueue, cfg.ThumbsDir, rtCfg, collectionsDB)
	indexingHandler := indexing.NewHandler(indexer, indexQueue, videoQueue)

	// Create geo components
	geoQueue := queue.New(1) // geo runs single-threaded due to rate limits
	geoDB := geo.NewGeoDB(db.Conn)
	rateLimitStateFile := filepath.Join(cfg.DataDir, "rate_limit_state.json")
	rateLimiter := geo.NewRateLimiter(rtCfg.GeonamesHourlyLimit, rtCfg.GeonamesDailyLimit, rateLimitStateFile)
	geoFinalizer := geo.NewFinalizer(geoDB, rateLimiter, cfg.GeonamesUsername)
	geoService := geo.NewService(geoFinalizer, geoQueue)
	geoHandler := geo.NewHandler(geoService)

	// Create ML components
	mlDB := ml.NewMLDB(db.Conn)
	mlService := ml.NewService(mlClient, mlDB)
	mlHandler := ml.NewHandler(mlService)

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

	// Admin handlers
	configHandler := admin.NewConfigHandler(rtCfg)
	usersHandler := admin.NewUsersHandler(authSvc)
	jobsHandler := admin.NewJobsHandler(sched, fileWatcher, scheduledIndexing, collectionsDB, frameManager)

	// Authn handler
	authnHandler := authn.NewHandler(authSvc)

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
	)

	slog.Info("starting Photo-Loka", "port", cfg.Port, "data_dir", cfg.DataDir)

	// Startup activities
	if rtCfg.StartFileWatcherAtStartup {
		if err := fileWatcher.StartForAllCollections(); err != nil {
			slog.Error("failed to start file watchers", "error", err)
		}
	}
	if rtCfg.StartScheduledIndexingAtStartup {
		if err := scheduledIndexing.ScheduleAll(); err != nil {
			slog.Error("failed to schedule intake indexing", "error", err)
		}
	}
	if err := frameManager.LoadAllFrames(); err != nil {
		slog.Error("failed to load frames", "error", err)
	}

	if err := srv.Run(); err != nil {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}

	// Shutdown activities
	sched.Stop()
	fileWatcher.StopAll()
	scheduledIndexing.StopAll()
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
