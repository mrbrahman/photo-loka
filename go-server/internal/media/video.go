package media

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Supported encoder values.
const (
	EncoderVP8  = "vp8"
	EncoderVP9  = "vp9"
	EncoderH264 = "h264"
	EncoderH265 = "h265"
	EncoderAV1  = "av1"
)

// CompressVideo compresses a video file using the specified encoder.
// The compressed output is stored in the thumbnail directory alongside
// the uuid's other generated assets.
func CompressVideo(uuid, filename, thumbsDir, encoder string) error {
	dir := thumbDir(uuid, thumbsDir)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create output directory %s: %w", dir, err)
	}

	encoder = strings.ToLower(encoder)

	switch encoder {
	case EncoderVP8:
		return compressVP8(filename, dir, uuid)
	case EncoderVP9:
		return compressVP9(filename, dir, uuid)
	case EncoderH264:
		return compressH264(filename, dir, uuid)
	case EncoderH265:
		return compressH265(filename, dir, uuid)
	case EncoderAV1:
		return compressAV1(filename, dir, uuid)
	default:
		return fmt.Errorf("unsupported encoder: %s", encoder)
	}
}

// ResolveVideoPath determines which video file to serve based on quality preference.
// If quality is "original", returns the original filename.
// Otherwise, looks for compressed variants in order of preference:
// VP9 2-pass > VP8 2-pass > generic compressed > original.
func ResolveVideoPath(uuid, filename, thumbsDir, quality string) string {
	if quality == "original" {
		return filename
	}

	dir := thumbDir(uuid, thumbsDir)

	// Check for compressed variants in priority order
	candidates := []string{
		filepath.Join(dir, uuid+"_compressed_video_vp9_2pass.webm"),
		filepath.Join(dir, uuid+"_compressed_video_vp8_2pass.webm"),
		filepath.Join(dir, uuid+"_compressed_video.webm"),
		filepath.Join(dir, uuid+"_compressed_video.mp4"),
	}

	for _, path := range candidates {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}

	// No compressed variant found, return original.
	return filename
}

// DeleteCompressedVideo removes all compressed video variants for the given uuid.
func DeleteCompressedVideo(uuid, thumbsDir string) {
	dir := thumbDir(uuid, thumbsDir)

	pattern := filepath.Join(dir, uuid+"_compressed_video*")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		slog.Error("failed to glob compressed videos for deletion", "uuid", uuid, "error", err)
		return
	}

	for _, match := range matches {
		if err := os.Remove(match); err != nil && !os.IsNotExist(err) {
			slog.Error("failed to delete compressed video", "path", match, "error", err)
		}
	}

	// Also remove any 2-pass log files
	logPattern := filepath.Join(dir, "ffmpeg2pass*")
	logMatches, _ := filepath.Glob(logPattern)
	for _, match := range logMatches {
		os.Remove(match)
	}

	slog.Debug("compressed videos deleted", "uuid", uuid, "count", len(matches))
}

// compressVP8 performs 2-pass VP8 encoding to webm.
func compressVP8(inputPath, outputDir, uuid string) error {
	outputPath := filepath.Join(outputDir, uuid+"_compressed_video_vp8_2pass.webm")
	passLogPrefix := filepath.Join(outputDir, "ffmpeg2pass")

	// Pass 1
	args1 := []string{
		"-i", inputPath,
		"-c:v", "libvpx",
		"-b:v", "1M",
		"-pass", "1",
		"-passlogfile", passLogPrefix,
		"-an",
		"-f", "webm",
		"-y",
		"/dev/null",
	}
	if err := runFFmpeg(args1); err != nil {
		return fmt.Errorf("VP8 pass 1 failed: %w", err)
	}

	// Pass 2
	args2 := []string{
		"-i", inputPath,
		"-c:v", "libvpx",
		"-b:v", "1M",
		"-pass", "2",
		"-passlogfile", passLogPrefix,
		"-c:a", "libvorbis",
		"-y",
		outputPath,
	}
	if err := runFFmpeg(args2); err != nil {
		return fmt.Errorf("VP8 pass 2 failed: %w", err)
	}

	// Clean up pass log files
	cleanPassLogs(passLogPrefix)

	slog.Info("VP8 compression complete", "uuid", uuid, "output", outputPath)
	return nil
}

// compressVP9 performs 2-pass VP9 encoding to webm.
func compressVP9(inputPath, outputDir, uuid string) error {
	outputPath := filepath.Join(outputDir, uuid+"_compressed_video_vp9_2pass.webm")
	passLogPrefix := filepath.Join(outputDir, "ffmpeg2pass")

	// Pass 1
	args1 := []string{
		"-i", inputPath,
		"-c:v", "libvpx-vp9",
		"-b:v", "1M",
		"-pass", "1",
		"-passlogfile", passLogPrefix,
		"-an",
		"-f", "webm",
		"-y",
		"/dev/null",
	}
	if err := runFFmpeg(args1); err != nil {
		return fmt.Errorf("VP9 pass 1 failed: %w", err)
	}

	// Pass 2
	args2 := []string{
		"-i", inputPath,
		"-c:v", "libvpx-vp9",
		"-b:v", "1M",
		"-pass", "2",
		"-passlogfile", passLogPrefix,
		"-c:a", "libopus",
		"-y",
		outputPath,
	}
	if err := runFFmpeg(args2); err != nil {
		return fmt.Errorf("VP9 pass 2 failed: %w", err)
	}

	// Clean up pass log files
	cleanPassLogs(passLogPrefix)

	slog.Info("VP9 compression complete", "uuid", uuid, "output", outputPath)
	return nil
}

// compressH264 performs single-pass H.264 encoding to mp4.
func compressH264(inputPath, outputDir, uuid string) error {
	outputPath := filepath.Join(outputDir, uuid+"_compressed_video.mp4")

	args := []string{
		"-i", inputPath,
		"-c:v", "libx264",
		"-preset", "medium",
		"-crf", "23",
		"-c:a", "aac",
		"-b:a", "128k",
		"-movflags", "+faststart",
		"-y",
		outputPath,
	}

	if err := runFFmpeg(args); err != nil {
		return fmt.Errorf("H.264 compression failed: %w", err)
	}

	slog.Info("H.264 compression complete", "uuid", uuid, "output", outputPath)
	return nil
}

// compressH265 performs single-pass H.265/HEVC encoding to mp4.
func compressH265(inputPath, outputDir, uuid string) error {
	outputPath := filepath.Join(outputDir, uuid+"_compressed_video.mp4")

	args := []string{
		"-i", inputPath,
		"-c:v", "libx265",
		"-preset", "medium",
		"-crf", "28",
		"-c:a", "aac",
		"-b:a", "128k",
		"-movflags", "+faststart",
		"-tag:v", "hvc1",
		"-y",
		outputPath,
	}

	if err := runFFmpeg(args); err != nil {
		return fmt.Errorf("H.265 compression failed: %w", err)
	}

	slog.Info("H.265 compression complete", "uuid", uuid, "output", outputPath)
	return nil
}

// compressAV1 performs single-pass AV1 encoding to webm.
func compressAV1(inputPath, outputDir, uuid string) error {
	outputPath := filepath.Join(outputDir, uuid+"_compressed_video.webm")

	args := []string{
		"-i", inputPath,
		"-c:v", "libaom-av1",
		"-crf", "30",
		"-b:v", "0",
		"-cpu-used", "4",
		"-c:a", "libopus",
		"-y",
		outputPath,
	}

	if err := runFFmpeg(args); err != nil {
		return fmt.Errorf("AV1 compression failed: %w", err)
	}

	slog.Info("AV1 compression complete", "uuid", uuid, "output", outputPath)
	return nil
}

// runFFmpeg executes an ffmpeg command with the given arguments.
// Returns an error if the process exits with a non-zero status.
func runFFmpeg(args []string) error {
	cmd := exec.Command("ffmpeg", args...)
	cmd.Stderr = nil // Suppress ffmpeg's verbose stderr output
	cmd.Stdout = nil

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg command failed (args: %v): %w", args, err)
	}
	return nil
}

// cleanPassLogs removes ffmpeg 2-pass log files.
func cleanPassLogs(prefix string) {
	pattern := prefix + "*"
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return
	}
	for _, match := range matches {
		os.Remove(match)
	}
}
