package media

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
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

// CreateImageThumbnails generates all standard thumbnail sizes for an image.
// Output files are stored in thumbsDir/u[0]/u[1]/u[2]/uuid_<height>_<suffix>.jpg
func CreateImageThumbnails(uuid, filePath, thumbsDir string) error {
	dir := thumbDir(uuid, thumbsDir)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create thumbnail directory %s: %w", dir, err)
	}

	for _, size := range thumbSizes {
		outputPath := thumbnailPath(uuid, thumbsDir, size)

		var vf string
		if size.Suffix == "center" {
			// Crop to fill: scale to cover the target, then crop to exact dimensions
			vf = fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d",
				size.Width, size.Height, size.Width, size.Height)
		} else {
			// Fit: scale proportionally to the target height
			vf = fmt.Sprintf("scale=-1:%d", size.Height)
		}

		args := []string{
			"-i", filePath,
			"-vf", vf,
			"-frames:v", "1",
			"-q:v", "3",
			"-y",
			outputPath,
		}

		if err := runFFmpeg(args); err != nil {
			slog.Error("thumbnail generation failed",
				"uuid", uuid,
				"size", fmt.Sprintf("%dx%d_%s", size.Width, size.Height, size.Suffix),
				"error", err,
			)
			return fmt.Errorf("failed to create thumbnail %s for %s: %w", size.Suffix, uuid, err)
		}
	}

	slog.Debug("thumbnails created", "uuid", uuid, "count", len(thumbSizes))
	return nil
}

// GenerateVideoThumbnail extracts a single frame from a video file to use as
// its thumbnail. Returns the path to the generated thumbnail.
func GenerateVideoThumbnail(uuid, videoFilePath, thumbsDir string) (string, error) {
	dir := thumbDir(uuid, thumbsDir)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("failed to create thumbnail directory %s: %w", dir, err)
	}

	outputPath := filepath.Join(dir, uuid+"_video_frame.jpg")

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

	slog.Debug("video thumbnail generated", "uuid", uuid, "path", outputPath)
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
// Uses the first 3 characters of the uuid as subdirectory levels:
// thumbsDir/u[0]/u[1]/u[2]/
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
	var filename string
	if size.Suffix == "center" {
		filename = fmt.Sprintf("%s_%d_%s.jpg", uuid, size.Height, size.Suffix)
	} else {
		filename = fmt.Sprintf("%s_%d_%s.jpg", uuid, size.Height, size.Suffix)
	}
	return filepath.Join(dir, filename)
}
