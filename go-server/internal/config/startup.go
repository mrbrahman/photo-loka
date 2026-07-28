package config

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"

	"github.com/joho/godotenv"
)

// StartupConfig holds configuration loaded from environment variables at startup.
type StartupConfig struct {
	DataDir          string
	ThumbsDir        string
	FacesDir         string
	DBFile           string
	JWTSecret        string
	MLServiceURL     string
	IndexerMode      string // "static" or "dynamic"
	GeonamesUsername string
	LogLevel         string
	NoColor          bool
	Port             int
}

// LoadStartupConfig loads configuration from environment variables (after loading .env).
func LoadStartupConfig() (*StartupConfig, error) {
	// Load .env file; ignore error if file not found
	_ = godotenv.Load()

	// Validate all required env vars upfront
	var missing []string

	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		missing = append(missing, "DATA_DIR")
	}

	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		missing = append(missing, "JWT_SECRET")
	}

	geonamesUsername := os.Getenv("GEONAMES_USERNAME")
	if geonamesUsername == "" {
		missing = append(missing, "GEONAMES_USERNAME")
	}

	if len(missing) > 0 {
		return nil, &MissingEnvError{Vars: missing}
	}

	mlServiceURL := os.Getenv("ML_SERVICE_URL")
	if mlServiceURL == "" {
		mlServiceURL = "http://localhost:8000"
		slog.Info("ML_SERVICE_URL not set, using default", "url", mlServiceURL)
	}

	indexerMode := os.Getenv("INDEXER_MODE")
	if indexerMode == "" {
		indexerMode = "static"
	}

	logLevel := os.Getenv("LOG_LEVEL")
	if logLevel == "" {
		logLevel = "info"
	}

	noColor := os.Getenv("NO_COLOR") != ""

	port := 9000
	if portStr := os.Getenv("PORT"); portStr != "" {
		p, err := strconv.Atoi(portStr)
		if err != nil {
			return nil, fmt.Errorf("invalid PORT value %q: %w", portStr, err)
		}
		port = p
	}

	cfg := &StartupConfig{
		DataDir:          dataDir,
		ThumbsDir:        filepath.Join(dataDir, "thumbnails"),
		FacesDir:         filepath.Join(dataDir, "faces"),
		DBFile:           filepath.Join(dataDir, "MEMORIES-DATABASE.sqlite"),
		JWTSecret:        jwtSecret,
		MLServiceURL:     mlServiceURL,
		IndexerMode:      indexerMode,
		GeonamesUsername: geonamesUsername,
		LogLevel:         logLevel,
		NoColor:          noColor,
		Port:             port,
	}

	return cfg, nil
}

// MissingEnvError holds the list of missing required environment variables.
type MissingEnvError struct {
	Vars []string
}

func (e *MissingEnvError) Error() string {
	return fmt.Sprintf("missing required environment variables: %v", e.Vars)
}
