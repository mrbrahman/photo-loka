package search

import (
	"fmt"
	"strings"
)

// Columns indexed in the porter FTS table (stemmed, NLP-style search)
var textCols = []string{"album_name", "description", "keywords"}

// Columns indexed in the unicode FTS table (exact token match)
var metaCols = []string{"filename", "mimetype", "mediatype", "faces", "make", "model", "geo_address", "album_date"}

// All FTS-searchable columns (union of both tables)
var restrictSearchCols = append(append([]string{}, textCols...), metaCols...)

// aliases maps shorthand/alternate column names to their canonical column.
var aliases = map[string]string{
	"tags":     "keywords",
	"people":   "faces",
	"name":     "faces",
	"face":     "faces",
	"loc":      "geo_address",
	"location": "geo_address",
	"address":  "geo_address",
	"camera":   "model",
	"type":     "mediatype",
	"desc":     "description",
	"album":    "album_name",
	"date":     "album_date",
	"l":        "logical",
}

const (
	ftsPorterTable  = "metadata_fts_porter"
	ftsUnicodeTable = "metadata_fts_unicode"
)

// getColTable determines which FTS table a column belongs to.
func getColTable(col string) string {
	for _, c := range textCols {
		if c == col {
			return "text"
		}
	}
	for _, c := range metaCols {
		if c == col {
			return "meta"
		}
	}
	return ""
}

// isRestrictedCol checks if a column is in the FTS-searchable set.
func isRestrictedCol(col string) bool {
	for _, c := range restrictSearchCols {
		if c == col {
			return true
		}
	}
	return false
}

// BuildFilter converts a search string into a SQL WHERE clause fragment.
// It parses key:value pairs, resolves aliases, and routes terms to the
// appropriate FTS tables or direct SQL conditions.
func BuildFilter(searchStr string) string {
	if strings.TrimSpace(searchStr) == "" {
		return ""
	}

	// Split respecting quoted strings
	filterItems := splitRespectingQuotes(searchStr)

	logical := "AND"
	var textFilters []string
	var metaFilters []string
	var broadFilters []string
	var otherFilters []string

	for _, item := range filterItems {
		// Split by first colon to get key:value
		key, value, hasColon := splitKeyValue(item)

		if !hasColon {
			// Un-prefixed: search across all columns in both FTS tables
			term := stripQuotes(item)
			if term != "" {
				broadFilters = append(broadFilters, term)
			}
			continue
		}

		// Resolve alias
		col := strings.ToLower(key)
		if alias, ok := aliases[col]; ok {
			col = alias
		}

		filterStr := stripQuotes(value)

		switch col {
		case "logical":
			logical = strings.ToUpper(filterStr)
		case "rating":
			otherFilters = append(otherFilters, fmt.Sprintf("rating = %s", value))
		case "private":
			val := 0
			if strings.EqualFold(filterStr, "true") || filterStr == "1" {
				val = 1
			}
			otherFilters = append(otherFilters, fmt.Sprintf("coalesce(is_private, 0) = %d", val))
		case "uuid":
			otherFilters = append(otherFilters, fmt.Sprintf("uuid = '%s'", filterStr))
		case "raw":
			otherFilters = append(otherFilters, filterStr)
		default:
			if isRestrictedCol(col) {
				table := getColTable(col)
				if table == "text" {
					textFilters = append(textFilters, fmt.Sprintf(`{%s} : ( "%s" )`, col, filterStr))
				} else if table == "meta" {
					metaFilters = append(metaFilters, fmt.Sprintf(`{%s} : ( "%s"* )`, col, filterStr))
				}
			}
			// Ignore unknown columns
		}
	}

	// Build the FTS filter clause(s)
	ftsClause := buildFtsClause(textFilters, metaFilters, broadFilters, logical)
	allOtherFilters := strings.Join(otherFilters, " "+logical+" ")

	var allFilters []string
	if ftsClause != "" {
		allFilters = append(allFilters, ftsClause)
	}
	if allOtherFilters != "" {
		allFilters = append(allFilters, allOtherFilters)
	}

	if len(allFilters) == 0 {
		return ""
	}

	return "( " + strings.Join(allFilters, " "+logical+" ") + " )"
}

// buildFtsClause constructs the combined FTS subquery clauses.
func buildFtsClause(textFilters, metaFilters, broadFilters []string, logical string) string {
	var parts []string

	// Handle broad (un-prefixed) terms: always OR across both tables
	if len(broadFilters) > 0 {
		porterTerms := make([]string, len(broadFilters))
		unicodeTerms := make([]string, len(broadFilters))
		for i, t := range broadFilters {
			porterTerms[i] = fmt.Sprintf(`"%s"`, t)
			unicodeTerms[i] = fmt.Sprintf(`"%s"*`, t)
		}
		porterExpr := strings.Join(porterTerms, " "+logical+" ")
		unicodeExpr := strings.Join(unicodeTerms, " "+logical+" ")

		textMatch := fmt.Sprintf("rowid IN (SELECT rowid FROM %s WHERE %s MATCH '%s')", ftsPorterTable, ftsPorterTable, porterExpr)
		metaMatch := fmt.Sprintf("rowid IN (SELECT rowid FROM %s WHERE %s MATCH '%s')", ftsUnicodeTable, ftsUnicodeTable, unicodeExpr)
		parts = append(parts, fmt.Sprintf("(%s OR %s)", textMatch, metaMatch))
	}

	// Handle column-prefixed terms routed to porter FTS
	if len(textFilters) > 0 {
		matchExpr := strings.Join(textFilters, " "+logical+" ")
		parts = append(parts, fmt.Sprintf("rowid IN (SELECT rowid FROM %s WHERE %s MATCH '%s')", ftsPorterTable, ftsPorterTable, matchExpr))
	}

	// Handle column-prefixed terms routed to unicode FTS
	if len(metaFilters) > 0 {
		matchExpr := strings.Join(metaFilters, " "+logical+" ")
		parts = append(parts, fmt.Sprintf("rowid IN (SELECT rowid FROM %s WHERE %s MATCH '%s')", ftsUnicodeTable, ftsUnicodeTable, matchExpr))
	}

	if len(parts) == 0 {
		return ""
	}

	return strings.Join(parts, " "+logical+" ")
}

// splitRespectingQuotes splits a string by whitespace but keeps quoted
// segments (including the content after a colon) together.
// E.g. `album:"trip to park" type:video` -> ["album:trip to park", "type:video"]
func splitRespectingQuotes(s string) []string {
	var result []string
	var current strings.Builder
	inQuote := false

	for i := 0; i < len(s); i++ {
		ch := s[i]
		switch {
		case ch == '"':
			inQuote = !inQuote
			// Don't include the quote character in output
		case ch == ' ' && !inQuote:
			if current.Len() > 0 {
				result = append(result, current.String())
				current.Reset()
			}
		default:
			current.WriteByte(ch)
		}
	}

	if current.Len() > 0 {
		result = append(result, current.String())
	}

	return result
}

// splitKeyValue splits a token by the first colon into key and value.
func splitKeyValue(token string) (key, value string, hasColon bool) {
	idx := strings.Index(token, ":")
	if idx < 0 {
		return token, "", false
	}
	return token[:idx], token[idx+1:], true
}

// stripQuotes removes leading and trailing double quotes from a string.
func stripQuotes(s string) string {
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		return s[1 : len(s)-1]
	}
	return s
}
