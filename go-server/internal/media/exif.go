package media

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"os/exec"
	"path/filepath"
	"strings"
)

// ExifData holds extracted metadata from a media file.
type ExifData struct {
	Description             *string                `json:"description"`
	Filesize                *int64                 `json:"filesize"`
	Ext                     string                 `json:"ext"`
	Mimetype                *string                `json:"mimetype"`
	Mediatype               string                 `json:"mediatype"`
	Keywords                []string               `json:"keywords"`
	Xmpregion               *string                `json:"xmpregion"`
	Faces                   []string               `json:"faces"`
	Rating                  int                    `json:"rating"`
	ImageWidth              *int                   `json:"image_width"`
	ImageHeight             *int                   `json:"image_height"`
	Aspectratio             float64                `json:"aspectratio"`
	Make                    *string                `json:"make"`
	Model                   *string                `json:"model"`
	Orientation             *int                   `json:"orientation"`
	Duration                *float64               `json:"duration"`
	GPSLat                  *float64               `json:"gps_lat"`
	GPSLng                  *float64               `json:"gps_lng"`
	GPSAlt                  *float64               `json:"gps_alt"`
	ExiftoolGeoJSON         map[string]interface{} `json:"exiftool_geo_json"`
	CapturedAt              *string                `json:"captured_at"`
	FileModifiedAt          *string                `json:"file_modified_at"`
	CaptureDateTime         *CaptureDateTime       `json:"capture_date_time"`
	CaptureTzName           *string                `json:"capture_tz_name"`
	ExifDatetimeOriginalRef *string
	ExifCreateDateRef       *string
}

// CaptureDateTime holds parsed date/time components from EXIF.
type CaptureDateTime struct {
	Year            int  `json:"year"`
	Month           int  `json:"month"`
	Day             int  `json:"day"`
	Hour            int  `json:"hour"`
	Minute          int  `json:"minute"`
	Second          int  `json:"second"`
	TzOffsetMinutes *int `json:"tz_offset_minutes,omitempty"`
}

// ExtractMetadata shells out to exiftool to extract metadata from a file.
// It returns a populated ExifData struct or an error.
func ExtractMetadata(filePath string) (*ExifData, error) {
	cmd := exec.Command("exiftool", "-json", "-n", "-G", "-struct", filePath)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("exiftool execution failed for %s: %w", filePath, err)
	}

	var results []map[string]interface{}
	if err := json.Unmarshal(output, &results); err != nil {
		return nil, fmt.Errorf("failed to parse exiftool JSON for %s: %w", filePath, err)
	}

	if len(results) == 0 {
		return nil, fmt.Errorf("exiftool returned no results for %s", filePath)
	}

	raw := results[0]
	data := &ExifData{}

	// File info
	data.Ext = strings.TrimPrefix(strings.ToLower(filepath.Ext(filePath)), ".")
	data.Filesize = getInt64Field(raw, "File:FileSize")
	data.Mimetype = getStringField(raw, "File:MIMEType")
	data.FileModifiedAt = getStringField(raw, "File:FileModifyDate")

	// Determine media type from MIME
	if data.Mimetype != nil {
		mime := *data.Mimetype
		if strings.HasPrefix(mime, "image/") {
			data.Mediatype = "photo"
		} else if strings.HasPrefix(mime, "video/") {
			data.Mediatype = "video"
		} else if strings.HasPrefix(mime, "audio/") {
			data.Mediatype = "audio"
		} else {
			data.Mediatype = "unknown"
		}
	} else {
		data.Mediatype = "unknown"
	}

	// Description - check multiple possible fields
	data.Description = firstString(raw,
		"EXIF:ImageDescription",
		"XMP:Description",
		"IPTC:Caption-Abstract",
	)

	// Camera info
	data.Make = firstString(raw, "EXIF:Make", "QuickTime:Make")
	data.Model = firstString(raw, "EXIF:Model", "QuickTime:Model")

	// Dimensions
	data.ImageWidth = getIntField(raw, "EXIF:ImageWidth", "File:ImageWidth", "QuickTime:ImageWidth")
	data.ImageHeight = getIntField(raw, "EXIF:ImageHeight", "File:ImageHeight", "QuickTime:ImageHeight")
	data.Orientation = getIntField(raw, "EXIF:Orientation")

	// Calculate aspect ratio with orientation correction
	if data.ImageWidth != nil && data.ImageHeight != nil && *data.ImageHeight > 0 {
		w := float64(*data.ImageWidth)
		h := float64(*data.ImageHeight)

		// Orientations 5-8 swap width and height
		if data.Orientation != nil && *data.Orientation >= 5 && *data.Orientation <= 8 {
			w, h = h, w
		}

		data.Aspectratio = math.Round(w/h*100) / 100
	}

	// Duration (video/audio)
	data.Duration = getFloatField(raw, "QuickTime:Duration", "EXIF:Duration")

	// GPS
	data.GPSLat = getFloatField(raw, "EXIF:GPSLatitude", "Composite:GPSLatitude")
	data.GPSLng = getFloatField(raw, "EXIF:GPSLongitude", "Composite:GPSLongitude")
	data.GPSAlt = getFloatField(raw, "EXIF:GPSAltitude")

	// Rating
	if r := getIntField(raw, "XMP:Rating", "EXIF:Rating"); r != nil {
		data.Rating = *r
	}

	// Keywords
	data.Keywords = getStringSlice(raw, "IPTC:Keywords", "XMP:Subject")

	// XMP Region (face regions) - serialize to JSON string
	if region, ok := raw["XMP:RegionInfo"]; ok {
		regionBytes, err := json.Marshal(region)
		if err == nil {
			regionStr := string(regionBytes)
			data.Xmpregion = &regionStr
		}
	}

	// Extract face names from XMP regions
	data.Faces = extractFaceNames(raw)

	// Capture date/time
	data.ExifDatetimeOriginalRef = getStringField(raw, "EXIF:DateTimeOriginal")
	data.ExifCreateDateRef = getStringField(raw, "EXIF:CreateDate", "QuickTime:CreateDate")

	// Use DateTimeOriginal first, fallback to CreateDate
	dateStr := data.ExifDatetimeOriginalRef
	if dateStr == nil {
		dateStr = data.ExifCreateDateRef
	}
	if dateStr != nil {
		data.CapturedAt = dateStr
		data.CaptureDateTime = parseCaptureDateTime(*dateStr)
	}

	// Timezone
	data.CaptureTzName = getStringField(raw, "EXIF:OffsetTimeOriginal", "EXIF:OffsetTime")

	// Geo JSON from exiftool (if present)
	if geoJSON, ok := raw["Composite:GPSPosition"]; ok {
		if geoMap, ok := geoJSON.(map[string]interface{}); ok {
			data.ExiftoolGeoJSON = geoMap
		}
	}

	return data, nil
}

// WriteMetadata shells out to exiftool to write metadata fields to a file.
func WriteMetadata(filePath string, updates map[string]interface{}) error {
	if len(updates) == 0 {
		return nil
	}

	args := []string{"-overwrite_original"}

	for field, value := range updates {
		args = append(args, fmt.Sprintf("-%s=%v", field, value))
	}

	args = append(args, filePath)

	cmd := exec.Command("exiftool", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("exiftool write failed for %s: %w (output: %s)", filePath, err, string(output))
	}

	return nil
}

// getStringField safely extracts a string value from the raw exiftool map.
// Tries each key in order and returns the first non-empty string found.
func getStringField(raw map[string]interface{}, keys ...string) *string {
	for _, key := range keys {
		if v, ok := raw[key]; ok {
			switch s := v.(type) {
			case string:
				if s != "" {
					return &s
				}
			case float64:
				str := fmt.Sprintf("%v", s)
				return &str
			}
		}
	}
	return nil
}

// firstString returns the first non-nil result from getStringField with one key each.
func firstString(raw map[string]interface{}, keys ...string) *string {
	for _, key := range keys {
		if s := getStringField(raw, key); s != nil {
			return s
		}
	}
	return nil
}

// getFloatField safely extracts a float64 value from the raw exiftool map.
func getFloatField(raw map[string]interface{}, keys ...string) *float64 {
	for _, key := range keys {
		if v, ok := raw[key]; ok {
			switch f := v.(type) {
			case float64:
				return &f
			case int:
				val := float64(f)
				return &val
			case string:
				// Some fields may be strings; skip them for float extraction.
			}
		}
	}
	return nil
}

// getIntField safely extracts an int value from the raw exiftool map.
func getIntField(raw map[string]interface{}, keys ...string) *int {
	for _, key := range keys {
		if v, ok := raw[key]; ok {
			switch n := v.(type) {
			case float64:
				i := int(n)
				return &i
			case int:
				return &n
			}
		}
	}
	return nil
}

// getInt64Field safely extracts an int64 value from the raw exiftool map.
func getInt64Field(raw map[string]interface{}, keys ...string) *int64 {
	for _, key := range keys {
		if v, ok := raw[key]; ok {
			switch n := v.(type) {
			case float64:
				i := int64(n)
				return &i
			case int:
				i := int64(n)
				return &i
			}
		}
	}
	return nil
}

// getStringSlice extracts a string slice from the raw exiftool map.
// Handles both single string values and arrays.
func getStringSlice(raw map[string]interface{}, keys ...string) []string {
	for _, key := range keys {
		if v, ok := raw[key]; ok {
			switch s := v.(type) {
			case string:
				if s != "" {
					return []string{s}
				}
			case []interface{}:
				var result []string
				for _, item := range s {
					if str, ok := item.(string); ok && str != "" {
						result = append(result, str)
					}
				}
				if len(result) > 0 {
					return result
				}
			}
		}
	}
	return nil
}

// extractFaceNames pulls face names from XMP Region data.
func extractFaceNames(raw map[string]interface{}) []string {
	regionInfo, ok := raw["XMP:RegionInfo"]
	if !ok {
		return nil
	}

	regionMap, ok := regionInfo.(map[string]interface{})
	if !ok {
		return nil
	}

	regionList, ok := regionMap["RegionList"]
	if !ok {
		return nil
	}

	regions, ok := regionList.([]interface{})
	if !ok {
		return nil
	}

	var faces []string
	for _, r := range regions {
		region, ok := r.(map[string]interface{})
		if !ok {
			continue
		}
		if name, ok := region["Name"].(string); ok && name != "" {
			faces = append(faces, name)
		}
	}

	return faces
}

// parseCaptureDateTime parses an EXIF date/time string into components.
// Handles formats like "2021:01:15 14:30:00" and "2021:01:15 14:30:00+05:30".
func parseCaptureDateTime(dateStr string) *CaptureDateTime {
	if dateStr == "" || dateStr == "0000:00:00 00:00:00" {
		return nil
	}

	dt := &CaptureDateTime{}

	// Split off timezone if present
	mainPart := dateStr
	var tzPart string

	// Look for +/- timezone offset (e.g. "+05:30" or "-04:00")
	for i := len(dateStr) - 1; i >= 0; i-- {
		if dateStr[i] == '+' || dateStr[i] == '-' {
			mainPart = dateStr[:i]
			tzPart = dateStr[i:]
			break
		}
	}

	// Parse main part: "2021:01:15 14:30:00"
	parts := strings.Fields(mainPart)
	if len(parts) < 1 {
		return nil
	}

	// Parse date
	dateParts := strings.Split(parts[0], ":")
	if len(dateParts) >= 3 {
		fmt.Sscanf(dateParts[0], "%d", &dt.Year)
		fmt.Sscanf(dateParts[1], "%d", &dt.Month)
		fmt.Sscanf(dateParts[2], "%d", &dt.Day)
	}

	// Parse time
	if len(parts) >= 2 {
		timeParts := strings.Split(parts[1], ":")
		if len(timeParts) >= 3 {
			fmt.Sscanf(timeParts[0], "%d", &dt.Hour)
			fmt.Sscanf(timeParts[1], "%d", &dt.Minute)
			fmt.Sscanf(timeParts[2], "%d", &dt.Second)
		}
	}

	// Parse timezone offset
	if tzPart != "" {
		offset := parseTzOffset(tzPart)
		if offset != nil {
			dt.TzOffsetMinutes = offset
		}
	}

	// Validate that we got a meaningful date
	if dt.Year == 0 && dt.Month == 0 && dt.Day == 0 {
		return nil
	}

	return dt
}

// parseTzOffset parses a timezone string like "+05:30" or "-04:00" into minutes.
func parseTzOffset(tz string) *int {
	if len(tz) < 5 {
		return nil
	}

	sign := 1
	if tz[0] == '-' {
		sign = -1
	}

	var hours, minutes int
	// Handle "+05:30" or "+0530"
	tzBody := tz[1:]
	if strings.Contains(tzBody, ":") {
		parts := strings.Split(tzBody, ":")
		if len(parts) >= 2 {
			fmt.Sscanf(parts[0], "%d", &hours)
			fmt.Sscanf(parts[1], "%d", &minutes)
		}
	} else if len(tzBody) >= 4 {
		fmt.Sscanf(tzBody[:2], "%d", &hours)
		fmt.Sscanf(tzBody[2:4], "%d", &minutes)
	}

	offset := sign * (hours*60 + minutes)

	slog.Debug("parsed timezone offset", "tz", tz, "offset_minutes", offset)

	return &offset
}
