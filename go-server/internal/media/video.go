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
	EncoderVP8  = "libvpx"
	EncoderVP9  = "libvpx-vp9"
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
	case EncoderH264, "h264_nvenc", "h264_qsv", "h264_amf":
		return compressH264(filename, dir, uuid, encoder)
	case EncoderH265, "hevc_nvenc", "hevc_qsv", "hevc_amf":
		return compressH265(filename, dir, uuid, encoder)
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
		filepath.Join(dir, uuid+"_2pass_vp9_compressed_video.webm"),
		filepath.Join(dir, uuid+"_2pass_vp8_compressed_video.webm"),
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

	pattern := filepath.Join(dir, uuid+"_*compressed_video*")
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
	outputPath := filepath.Join(outputDir, uuid+"_2pass_vp8_compressed_video.webm")
	passLogPrefix := filepath.Join(os.TempDir(), fmt.Sprintf("ffmpeg2pass-%s", uuid))

	commonArgs := []string{
		"-c:v", "libvpx",
		"-b:v", "2.5M",
		"-vf", "scale=-2:'min(ih,720)'",
		"-threads", "4",
		"-colorspace", "bt709",
		"-color_primaries", "bt709",
		"-color_trc", "bt709",
	}

	// Pass 1
	args1 := []string{"-i", inputPath}
	args1 = append(args1, commonArgs...)
	args1 = append(args1, "-pass", "1", "-passlogfile", passLogPrefix, "-an", "-f", "null", "/dev/null")
	if err := runFFmpeg(args1); err != nil {
		return fmt.Errorf("VP8 pass 1 failed: %w", err)
	}

	// Pass 2
	args2 := []string{"-i", inputPath}
	args2 = append(args2, commonArgs...)
	args2 = append(args2, "-pass", "2", "-passlogfile", passLogPrefix,
		"-c:a", "libvorbis", "-b:a", "128k", "-y", outputPath)
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
	outputPath := filepath.Join(outputDir, uuid+"_2pass_vp9_compressed_video.webm")
	passLogPrefix := filepath.Join(os.TempDir(), fmt.Sprintf("ffmpeg2pass-vp9-%s", uuid))

	commonArgs := []string{
		"-c:v", "libvpx-vp9",
		"-b:v", "2.5M",
		"-crf", "32",
		"-vf", "scale=-2:'min(ih,720)'",
		"-threads", "4",
		"-row-mt", "1",
		"-pix_fmt", "yuv420p",
		"-colorspace", "bt709",
		"-color_primaries", "bt709",
		"-color_trc", "bt709",
	}

	// Pass 1
	args1 := []string{"-i", inputPath}
	args1 = append(args1, commonArgs...)
	args1 = append(args1, "-pass", "1", "-passlogfile", passLogPrefix, "-speed", "4", "-an", "-f", "null", "/dev/null")
	if err := runFFmpeg(args1); err != nil {
		return fmt.Errorf("VP9 pass 1 failed: %w", err)
	}

	// Pass 2
	args2 := []string{"-i", inputPath}
	args2 = append(args2, commonArgs...)
	args2 = append(args2, "-pass", "2", "-passlogfile", passLogPrefix, "-speed", "1",
		"-c:a", "libopus", "-b:a", "128k", "-y", outputPath)
	if err := runFFmpeg(args2); err != nil {
		return fmt.Errorf("VP9 pass 2 failed: %w", err)
	}

	// Clean up pass log files
	cleanPassLogs(passLogPrefix)

	slog.Info("VP9 compression complete", "uuid", uuid, "output", outputPath)
	return nil
}

// compressH264 performs single-pass H.264 encoding to mp4.
func compressH264(inputPath, outputDir, uuid, encoder string) error {
	outputPath := filepath.Join(outputDir, uuid+"_compressed_video.mp4")

	isHardware := strings.Contains(encoder, "nvenc") || strings.Contains(encoder, "qsv") || strings.Contains(encoder, "amf")

	args := []string{"-i", inputPath, "-c:v", encoder}

	if isHardware {
		args = append(args, "-preset", "fast")
	}

	args = append(args,
		"-crf", "23",
		"-c:a", "aac",
		"-maxrate", "1.5M",
		"-bufsize", "3M",
		"-movflags", "+faststart",
		"-y", outputPath,
	)

	if err := runFFmpeg(args); err != nil {
		return fmt.Errorf("H.264 compression failed: %w", err)
	}

	slog.Info("H.264 compression complete", "uuid", uuid, "encoder", encoder, "output", outputPath)
	return nil
}

// compressH265 performs single-pass H.265/HEVC encoding to mp4.
func compressH265(inputPath, outputDir, uuid, encoder string) error {
	outputPath := filepath.Join(outputDir, uuid+"_compressed_video.mp4")

	isHardware := strings.Contains(encoder, "nvenc") || strings.Contains(encoder, "qsv") || strings.Contains(encoder, "amf")

	args := []string{"-i", inputPath, "-c:v", encoder}

	if isHardware {
		args = append(args, "-preset", "fast")
	}

	args = append(args,
		"-crf", "28",
		"-c:a", "aac",
		"-maxrate", "1.5M",
		"-bufsize", "3M",
		"-movflags", "+faststart",
		"-tag:v", "hvc1",
		"-y", outputPath,
	)

	if err := runFFmpeg(args); err != nil {
		return fmt.Errorf("H.265 compression failed: %w", err)
	}

	slog.Info("H.265 compression complete", "uuid", uuid, "encoder", encoder, "output", outputPath)
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
