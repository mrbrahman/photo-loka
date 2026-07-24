package config

import (
	"fmt"
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

	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		return nil, fmt.Errorf("DATA_DIR environment variable is required")
	}

	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET environment variable is required")
	}

	mlServiceURL := os.Getenv("ML_SERVICE_URL")
	if mlServiceURL == "" {
		mlServiceURL = "http://localhost:8000"
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
		GeonamesUsername: os.Getenv("GEONAMES_USERNAME"),
		LogLevel:         logLevel,
		NoColor:          noColor,
		Port:             port,
	}

	return cfg, nil
}
