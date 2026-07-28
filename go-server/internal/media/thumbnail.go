package media

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/davidbyttow/govips/v2/vips"
)

// thumbSize defines a thumbnail dimension and scaling mode.
type thumbSize struct {
	Width  int
	Height int
	Suffix string // "fit" for proportional scaling, "center" for crop-to-fill
}

// Standard thumbnail sizes generated for each image.
var thumbSizes = []thumbSize{
	{Height: 20, Suffix: "fit"},
	{Height: 100, Suffix: "fit"},
	{Height: 250, Suffix: "fit"},
	{Height: 500, Suffix: "fit"},
	{Width: 50, Height: 50, Suffix: "center"},
}

// InitVips initializes the govips library. Call once at startup.
func InitVips() {
	vips.LoggingSettings(nil, vips.LogLevelWarning)
	vips.Startup(nil)
}

// ShutdownVips cleans up govips resources. Call at shutdown.
func ShutdownVips() {
	vips.Shutdown()
}

// CreateImageThumbnails generates all standard thumbnail sizes for an image
// using libvips (via govips). Output files are stored in
// thumbsDir/u[0]/u[1]/u[2]/uuid_<height>_<suffix>.jpg
func CreateImageThumbnails(uuid, filePath, thumbsDir string) error {
	start := time.Now()

	dir := thumbDir(uuid, thumbsDir)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create thumbnail directory %s: %w", dir, err)
	}

	// Load the image once
	img, err := vips.NewImageFromFile(filePath)
	if err != nil {
		return fmt.Errorf("failed to load image %s: %w", filePath, err)
	}
	defer img.Close()

	// Auto-rotate based on EXIF orientation
	if err := img.AutoRotate(); err != nil {
		slog.Warn("auto-rotate failed, continuing without rotation", "uuid", uuid, "error", err)
	}

	for _, size := range thumbSizes {
		outputPath := thumbnailPath(uuid, thumbsDir, size)

		// Create a copy for each size (govips mutates the image)
		thumb, err := img.Copy()
		if err != nil {
			slog.Error("failed to copy image for thumbnail", "uuid", uuid, "error", err)
			continue
		}

		if size.Suffix == "center" {
			// Crop to fill: resize to cover, then smart-crop to exact dimensions
			scale := maxFloat(float64(size.Width)/float64(thumb.Width()), float64(size.Height)/float64(thumb.Height()))
			if err := thumb.Resize(scale, vips.KernelLanczos3); err != nil {
				thumb.Close()
				slog.Error("resize failed", "uuid", uuid, "size", size, "error", err)
				continue
			}
			if err := thumb.SmartCrop(size.Width, size.Height, vips.InterestingAttention); err != nil {
				// Fallback: simple crop from center if smart crop fails
				left := (thumb.Width() - size.Width) / 2
				top := (thumb.Height() - size.Height) / 2
				if left < 0 {
					left = 0
				}
				if top < 0 {
					top = 0
				}
				_ = thumb.ExtractArea(left, top, size.Width, size.Height)
			}
		} else {
			// Fit: scale proportionally to target height
			scale := float64(size.Height) / float64(thumb.Height())
			if scale < 1 {
				if err := thumb.Resize(scale, vips.KernelLanczos3); err != nil {
					thumb.Close()
					slog.Error("resize failed", "uuid", uuid, "size", size, "error", err)
					continue
				}
			}
		}

		// Export as JPEG
		bytes, _, err := thumb.ExportJpeg(&vips.JpegExportParams{Quality: 80})
		thumb.Close()
		if err != nil {
			slog.Error("JPEG export failed", "uuid", uuid, "size", size, "error", err)
			continue
		}

		if err := os.WriteFile(outputPath, bytes, 0644); err != nil {
			slog.Error("failed to write thumbnail", "path", outputPath, "error", err)
			continue
		}
	}

	slog.Info("thumbnails created", "uuid", uuid, "count", len(thumbSizes), "duration", time.Since(start).String())
	return nil
}

// ResizeImage resizes an image to fit within maxWidth x maxHeight,
// preserving aspect ratio. Returns JPEG bytes. Used for on-the-fly
// image serving (getImage endpoint).
func ResizeImage(filePath string, maxWidth, maxHeight int) ([]byte, error) {
	img, err := vips.NewImageFromFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to load image: %w", err)
	}
	defer img.Close()

	// Auto-rotate based on EXIF orientation
	if err := img.AutoRotate(); err != nil {
		slog.Warn("auto-rotate failed", "file", filePath, "error", err)
	}

	// Only downscale, never upscale
	scaleW := float64(maxWidth) / float64(img.Width())
	scaleH := float64(maxHeight) / float64(img.Height())
	scale := minFloat(scaleW, scaleH)

	if scale < 1 {
		if err := img.Resize(scale, vips.KernelLanczos3); err != nil {
			return nil, fmt.Errorf("resize failed: %w", err)
		}
	}

	bytes, _, err := img.ExportJpeg(&vips.JpegExportParams{Quality: 85})
	if err != nil {
		return nil, fmt.Errorf("JPEG export failed: %w", err)
	}

	return bytes, nil
}

// GenerateVideoThumbnail extracts a single frame from a video file using ffmpeg.
// Returns the path to the generated frame image. After this, call
// CreateImageThumbnails with the frame image to generate all sizes.
func GenerateVideoThumbnail(uuid, videoFilePath, thumbsDir string) (string, error) {
	start := time.Now()

	dir := thumbDir(uuid, thumbsDir)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("failed to create thumbnail directory %s: %w", dir, err)
	}

	outputPath := filepath.Join(dir, uuid+".jpg")

	args := []string{
		"-i", videoFilePath,
		"-vframes", "1",
		"-q:v", "3",
		"-y",
		outputPath,
	}

	if err := runFFmpeg(args); err != nil {
		return "", fmt.Errorf("failed to extract video thumbnail for %s: %w", uuid, err)
	}

	slog.Info("video thumbnail generated", "uuid", uuid, "duration", time.Since(start).String())
	return outputPath, nil
}

// DeleteThumbnails removes all thumbnail files for the given uuid.
func DeleteThumbnails(uuid, thumbsDir string) {
	dir := thumbDir(uuid, thumbsDir)

	pattern := filepath.Join(dir, uuid+"*")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		slog.Error("failed to glob thumbnails for deletion", "uuid", uuid, "error", err)
		return
	}

	for _, match := range matches {
		if err := os.Remove(match); err != nil && !os.IsNotExist(err) {
			slog.Error("failed to delete thumbnail", "path", match, "error", err)
		}
	}

	slog.Debug("thumbnails deleted", "uuid", uuid, "count", len(matches))
}

// thumbDir returns the directory path for a uuid's thumbnails.
func thumbDir(uuid, thumbsDir string) string {
	if len(uuid) < 3 {
		return filepath.Join(thumbsDir, uuid)
	}
	return filepath.Join(
		thumbsDir,
		string(uuid[0]),
		string(uuid[1]),
		string(uuid[2]),
	)
}

// thumbnailPath returns the output file path for a specific thumbnail size.
func thumbnailPath(uuid, thumbsDir string, size thumbSize) string {
	dir := thumbDir(uuid, thumbsDir)
	filename := fmt.Sprintf("%s_%d_%s.jpg", uuid, size.Height, size.Suffix)
	return filepath.Join(dir, filename)
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

// ExtractFaceThumbnails crops face regions from an image and saves them
// as individual thumbnails in facesDir/<cluster_id>/<uuid>.jpg.
// Uses bounding boxes from the ML service response.
func ExtractFaceThumbnails(uuid, imagePath string, faces []map[string]interface{}, facesDir string) error {
	// Load and auto-rotate the image (ML bbox is in rotated space)
	img, err := vips.NewImageFromFile(imagePath)
	if err != nil {
		return fmt.Errorf("loading image for face extraction: %w", err)
	}
	defer img.Close()

	if err := img.AutoRotate(); err != nil {
		slog.Warn("auto-rotate failed for face extraction", "uuid", uuid, "error", err)
	}

	imgW := img.Width()
	imgH := img.Height()

	for _, face := range faces {
		cluster, ok := face["cluster"].(map[string]interface{})
		if !ok {
			continue
		}
		clusterID, _ := cluster["cluster_id"].(string)
		if clusterID == "" {
			continue
		}

		// Get bbox [x1, y1, x2, y2]
		bboxRaw, ok := face["bbox"].([]interface{})
		if !ok || len(bboxRaw) < 4 {
			continue
		}
		x1 := toFloat(bboxRaw[0])
		y1 := toFloat(bboxRaw[1])
		x2 := toFloat(bboxRaw[2])
		y2 := toFloat(bboxRaw[3])

		bw := x2 - x1
		bh := y2 - y1

		// Pad by 40% of max dimension, then square up
		pad := max64(bw, bh) * 0.4
		cx := (x1 + x2) / 2
		cy := (y1 + y2) / 2
		half := (max64(bw, bh) + pad*2) / 2

		left := int(max64(0, cx-half))
		top := int(max64(0, cy-half))
		right := int(min64(float64(imgW), cx+half))
		bottom := int(min64(float64(imgH), cy+half))

		width := right - left
		height := bottom - top
		if width <= 0 || height <= 0 {
			continue
		}

		// Create face directory
		faceDir := filepath.Join(facesDir, clusterID)
		if err := os.MkdirAll(faceDir, 0755); err != nil {
			slog.Warn("failed to create face dir", "dir", faceDir, "error", err)
			continue
		}

		// Copy image and extract the face region
		faceCopy, err := img.Copy()
		if err != nil {
			continue
		}

		if err := faceCopy.ExtractArea(left, top, width, height); err != nil {
			faceCopy.Close()
			continue
		}

		bytes, _, err := faceCopy.ExportJpeg(&vips.JpegExportParams{Quality: 80})
		faceCopy.Close()
		if err != nil {
			continue
		}

		outputPath := filepath.Join(faceDir, uuid+".jpg")
		if err := os.WriteFile(outputPath, bytes, 0644); err != nil {
			slog.Warn("failed to write face thumbnail", "path", outputPath, "error", err)
		}
	}

	slog.Debug("face thumbnails extracted", "uuid", uuid, "count", len(faces))
	return nil
}

func toFloat(v interface{}) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	}
	return 0
}

func max64(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func min64(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
