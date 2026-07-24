package utils

import (
	"path/filepath"
	"regexp"
)

// ignorePattern matches filenames that should be ignored during indexing:
// - Starts with . or #
// - Ends with __ or ~
// - Contains "compressed_video"
var ignorePattern = regexp.MustCompile(`^[.#]|(?:__|~)$|compressed_video`)

// ShouldIgnoreFile returns true if the file at the given path should be
// ignored during indexing. Only the basename is checked against the pattern.
func ShouldIgnoreFile(filePath string) bool {
	basename := filepath.Base(filePath)
	return ignorePattern.MatchString(basename)
}
