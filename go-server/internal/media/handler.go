package media

import (
	"database/sql"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/database"
)

// Package-level media directories, set via RegisterRoutes.
var (
	thumbsDir string
	facesDir  string
)

// RegisterRoutes registers media routes on the given router group.
func RegisterRoutes(rg *gin.RouterGroup, thumbs, faces string) {
	thumbsDir = thumbs
	facesDir = faces
	rg.GET("/getThumbnail", getThumbnail)
	rg.GET("/getImage", getImage)
	rg.GET("/getVideo", getVideo)
	rg.GET("/getFaceThumbnail", getFaceThumbnail)
}

// getThumbnail serves a thumbnail image for the given uuid and height.
// Thumbnails are stored at: thumbsDir/u[0]/u[1]/u[2]/uuid_hN.webp
func getThumbnail(c *gin.Context) {
	uuid := c.Query("uuid")
	if uuid == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "uuid query parameter is required", "code": "VALIDATION_ERROR"},
		})
		return
	}

	heightStr := c.DefaultQuery("height", "250")
	height, err := strconv.Atoi(heightStr)
	if err != nil {
		height = 250
	}

	// Bucket the height to standard sizes
	heightBucket := bucketHeight(height)

	// Build thumbnail path: first 3 chars of uuid as subdirectories
	// e.g. uuid "abc123..." -> thumbsDir/a/b/c/abc123..._h250.webp
	if len(uuid) < 3 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Invalid uuid", "code": "VALIDATION_ERROR"},
		})
		return
	}

	thumbPath := filepath.Join(
		thumbsDir,
		string(uuid[0]),
		string(uuid[1]),
		string(uuid[2]),
		fmt.Sprintf("%s_%d_fit.jpg", uuid, heightBucket),
	)

	if _, err := os.Stat(thumbPath); os.IsNotExist(err) {
		c.Status(http.StatusNotFound)
		return
	}

	c.Header("Cache-Control", "public, max-age=31536000, immutable")
	c.File(thumbPath)
}

// getImage serves a resized image (fit within 1920x1080) for the given uuid.
func getImage(c *gin.Context) {
	uuid := c.Query("uuid")
	if uuid == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "uuid query parameter is required", "code": "VALIDATION_ERROR"},
		})
		return
	}

	// filename in DB is the absolute path
	var filename string
	err := database.DB.QueryRow("SELECT filename FROM metadata WHERE uuid = ?", uuid).Scan(&filename)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"error": gin.H{"message": "Item not found", "code": "NOT_FOUND"},
		})
		return
	}

	if _, err := os.Stat(filename); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{
			"error": gin.H{"message": "File not found on disk", "code": "NOT_FOUND"},
		})
		return
	}

	// Resize on-the-fly to fit within 1920x1080 (like Node.js sharp)
	bytes, err := ResizeImage(filename, 1920, 1080)
	if err != nil {
		// Fallback: serve original if resize fails (e.g. unsupported format)
		c.File(filename)
		return
	}

	c.Data(http.StatusOK, "image/jpeg", bytes)
}

// getVideo serves a video file with range request support.
// If quality=compressed, tries the compressed webm first; otherwise serves original.
func getVideo(c *gin.Context) {
	uuid := c.Query("uuid")
	if uuid == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "uuid query parameter is required", "code": "VALIDATION_ERROR"},
		})
		return
	}

	quality := c.DefaultQuery("quality", "compressed")

	var filename string
	err := database.DB.QueryRow("SELECT filename FROM metadata WHERE uuid = ?", uuid).Scan(&filename)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"error": gin.H{"message": "Item not found", "code": "NOT_FOUND"},
		})
		return
	}

	var servePath string

	if quality == "compressed" && len(uuid) >= 3 {
		// Check for compressed versions in priority order (matching Node.js resolveVideoPath)
		thumbDir := filepath.Join(thumbsDir, string(uuid[0]), string(uuid[1]), string(uuid[2]))
		candidates := []string{
			filepath.Join(thumbDir, uuid+"_2pass_vp9_compressed_video.webm"),
			filepath.Join(thumbDir, uuid+"_2pass_vp8_compressed_video.webm"),
			filepath.Join(thumbDir, uuid+"_compressed_video.webm"),
			filepath.Join(thumbDir, uuid+"_compressed_video.mp4"),
		}
		for _, candidate := range candidates {
			if _, err := os.Stat(candidate); err == nil {
				servePath = candidate
				break
			}
		}
	}

	// Fall back to original file
	if servePath == "" {
		servePath = filename
	}

	if _, err := os.Stat(servePath); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{
			"error": gin.H{"message": "Video file not found on disk", "code": "NOT_FOUND"},
		})
		return
	}

	// Use http.ServeContent for proper Range header support
	file, err := os.Open(servePath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": "Failed to open video file", "code": "INTERNAL_ERROR"},
		})
		return
	}
	defer file.Close()

	stat, err := file.Stat()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": "Failed to stat video file", "code": "INTERNAL_ERROR"},
		})
		return
	}

	// Set content type based on file extension
	contentType := getVideoContentType(servePath)
	c.Header("Content-Type", contentType)

	// http.ServeContent handles Range requests automatically (206 Partial Content)
	http.ServeContent(c.Writer, c.Request, filepath.Base(servePath), stat.ModTime(), file)
}

// getFaceThumbnail serves a face thumbnail image.
// Path: facesDir/cluster_id/uuid.jpg
func getFaceThumbnail(c *gin.Context) {
	uuid := c.Query("uuid")
	if uuid == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "uuid query parameter is required", "code": "VALIDATION_ERROR"},
		})
		return
	}

	clusterID := c.Query("cluster_id")
	if clusterID == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "cluster_id query parameter is required", "code": "VALIDATION_ERROR"},
		})
		return
	}

	facePath := filepath.Join(facesDir, clusterID, uuid+".jpg")

	if _, err := os.Stat(facePath); os.IsNotExist(err) {
		c.Status(http.StatusNotFound)
		return
	}

	c.Header("Cache-Control", "public, max-age=31536000, immutable")
	c.File(facePath)
}

// getFilePathByUUID looks up the filename and collection_path for a given UUID.
func getFilePathByUUID(uuid string) (filename, collectionPath string, err error) {
	query := `
		SELECT m.filename, c.collection_path
		FROM metadata m
		JOIN collections c ON m.collection_id = c.collection_id
		WHERE m.uuid = ?`

	var fname, cpath sql.NullString
	err = database.DB.QueryRow(query, uuid).Scan(&fname, &cpath)
	if err == sql.ErrNoRows {
		return "", "", nil
	}
	if err != nil {
		return "", "", fmt.Errorf("querying file path for uuid %s: %w", uuid, err)
	}

	if !fname.Valid || !cpath.Valid {
		return "", "", nil
	}

	return fname.String, cpath.String, nil
}

// bucketHeight rounds a height value to the nearest standard thumbnail size.
func bucketHeight(height int) int {
	// Match Node.js: [100, 250, 500].filter(x => x >= height)[0] || 500
	if height <= 100 {
		return 100
	}
	if height <= 250 {
		return 250
	}
	return 500
}

// getVideoContentType returns the appropriate content type for a video file.
func getVideoContentType(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".webm":
		return "video/webm"
	case ".mp4":
		return "video/mp4"
	case ".mov":
		return "video/quicktime"
	case ".avi":
		return "video/x-msvideo"
	case ".mkv":
		return "video/x-matroska"
	default:
		return "video/mp4"
	}
}
