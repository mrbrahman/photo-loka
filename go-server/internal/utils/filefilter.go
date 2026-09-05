package utils

import (
	"path/filepath"
	"regexp"
	"strings"
)

// TrashPrefix marks a file that has been moved to trash in-place.
// PrivatePrefix (a leading dot) marks a file as private.
const (
	TrashPrefix   = ".Trash_"
	PrivatePrefix = "."
)

// junkPattern matches basenames that are never media and should be ignored
// during indexing, regardless of any private/trash prefix:
//   - Starts with '#' (editor/temp files)
//   - Ends with '__' or '~' (temp/backup files)
//   - Contains "compressed_video" (our own generated derivatives)
//
// NOTE: a leading '.' is intentionally NOT treated as junk here. In this app a
// leading dot marks a file as private and ".Trash_" marks it as trashed; such
// files are still real media that must be indexed (with the right flags). The
// junk rules are therefore evaluated against the "underlying" name after any
// private/trash prefix is stripped, so ".DS_Store" style junk is still caught
// via the '#'/suffix rules or by having no media content.
var junkPattern = regexp.MustCompile(`^#|(?:__|~)$|compressed_video`)

// StripStatusPrefix removes a leading ".Trash_" or "." prefix from a basename
// and returns the underlying name plus whether the file is trashed/private.
// ".Trash_" is checked first because it also begins with ".".
func StripStatusPrefix(basename string) (underlying string, isTrashed, isPrivate bool) {
	if strings.HasPrefix(basename, TrashPrefix) {
		return strings.TrimPrefix(basename, TrashPrefix), true, false
	}
	if strings.HasPrefix(basename, PrivatePrefix) {
		return strings.TrimPrefix(basename, PrivatePrefix), false, true
	}
	return basename, false, false
}

// ShouldIgnoreFile returns true if the file at the given path should be
// ignored during indexing. Private/trash-prefixed media are NOT ignored; the
// junk rules are applied to the name with any such prefix removed.
func ShouldIgnoreFile(filePath string) bool {
	basename := filepath.Base(filePath)
	underlying, _, _ := StripStatusPrefix(basename)
	// If stripping a status prefix leaves nothing (e.g. a bare ".") treat as junk.
	if underlying == "" {
		return true
	}
	return junkPattern.MatchString(underlying)
}
