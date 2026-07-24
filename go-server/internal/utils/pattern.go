package utils

import (
	"fmt"
	"regexp"
	"strings"
)

// Supported pattern tokens.
const (
	tokenYYYY  = "{{yyyy}}"
	tokenYY    = "{{yy}}"
	tokenMM    = "{{mm}}"
	tokenDD    = "{{dd}}"
	tokenAlbum = "{{album}}"
)

// segmentKind identifies whether a segment is literal text or a token.
type segmentKind int

const (
	literal segmentKind = iota
	token
)

// segment represents a piece of a pattern (either literal text or a token).
type segment struct {
	kind  segmentKind
	value string
}

// FormatPattern replaces tokens in the pattern with values from the map.
// Numeric tokens (yyyy, yy, mm, dd) are zero-padded to their expected width.
// If the album value is empty and {{album}} is the last token, trailing
// whitespace before it is trimmed.
func FormatPattern(values map[string]string, pattern string) (string, error) {
	if err := validatePattern(pattern); err != nil {
		return "", err
	}

	segments := tokenize(pattern)
	var b strings.Builder

	for _, seg := range segments {
		if seg.kind == literal {
			b.WriteString(seg.value)
			continue
		}

		switch seg.value {
		case tokenYYYY:
			v := values["yyyy"]
			b.WriteString(padLeft(v, 4))
		case tokenYY:
			v := values["yy"]
			b.WriteString(padLeft(v, 2))
		case tokenMM:
			v := values["mm"]
			b.WriteString(padLeft(v, 2))
		case tokenDD:
			v := values["dd"]
			b.WriteString(padLeft(v, 2))
		case tokenAlbum:
			album := values["album"]
			if album == "" {
				// Trim trailing whitespace before empty album.
				result := strings.TrimRight(b.String(), " ")
				b.Reset()
				b.WriteString(result)
			} else {
				b.WriteString(album)
			}
		default:
			return "", fmt.Errorf("unknown token: %s", seg.value)
		}
	}

	return b.String(), nil
}

// ParsePattern attempts to match an input string against the given pattern
// and extract token values. Returns nil if the input does not match.
// The {{album}} token matches greedily (.*).
func ParsePattern(input, pattern string) map[string]string {
	if err := validatePattern(pattern); err != nil {
		return nil
	}

	segments := tokenize(pattern)
	regexStr := buildRegex(segments)

	re, err := regexp.Compile("^" + regexStr + "$")
	if err != nil {
		return nil
	}

	matches := re.FindStringSubmatch(input)
	if matches == nil {
		return nil
	}

	// Extract named capture groups.
	result := make(map[string]string)
	for i, name := range re.SubexpNames() {
		if name != "" && i < len(matches) {
			result[name] = matches[i]
		}
	}

	return result
}

// tokenize splits a pattern string into segments of literal text and tokens.
func tokenize(pattern string) []segment {
	var segments []segment
	remaining := pattern

	for remaining != "" {
		// Find the next token occurrence.
		idx := strings.Index(remaining, "{{")
		if idx == -1 {
			// No more tokens, rest is literal.
			segments = append(segments, segment{kind: literal, value: remaining})
			break
		}

		// Literal before the token.
		if idx > 0 {
			segments = append(segments, segment{kind: literal, value: remaining[:idx]})
		}

		// Find closing braces.
		endIdx := strings.Index(remaining[idx:], "}}")
		if endIdx == -1 {
			// Malformed token, treat rest as literal.
			segments = append(segments, segment{kind: literal, value: remaining[idx:]})
			break
		}

		tok := remaining[idx : idx+endIdx+2]
		segments = append(segments, segment{kind: token, value: tok})
		remaining = remaining[idx+endIdx+2:]
	}

	return segments
}

// validatePattern ensures the pattern is well-formed.
// If {{album}} is present, it must be the last token.
func validatePattern(pattern string) error {
	segments := tokenize(pattern)

	albumFound := false
	for i, seg := range segments {
		if seg.kind == token && seg.value == tokenAlbum {
			albumFound = true
			// Check that no other token follows.
			for j := i + 1; j < len(segments); j++ {
				if segments[j].kind == token {
					return fmt.Errorf("{{album}} must be the last token in pattern")
				}
			}
		}
	}

	_ = albumFound // album is optional
	return nil
}

// buildRegex converts tokenized segments into a regex string with named groups.
func buildRegex(segments []segment) string {
	var b strings.Builder

	for _, seg := range segments {
		if seg.kind == literal {
			b.WriteString(regexp.QuoteMeta(seg.value))
			continue
		}

		switch seg.value {
		case tokenYYYY:
			b.WriteString(`(?P<yyyy>\d{4})`)
		case tokenYY:
			b.WriteString(`(?P<yy>\d{2})`)
		case tokenMM:
			b.WriteString(`(?P<mm>\d{2})`)
		case tokenDD:
			b.WriteString(`(?P<dd>\d{2})`)
		case tokenAlbum:
			// Greedy match for album (last token).
			b.WriteString(`(?P<album>.*)`)
		}
	}

	return b.String()
}

// padLeft pads a string with leading zeros to the specified width.
func padLeft(s string, width int) string {
	for len(s) < width {
		s = "0" + s
	}
	return s
}
