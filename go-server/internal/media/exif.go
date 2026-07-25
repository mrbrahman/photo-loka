package media

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	exiftool "github.com/barasher/go-exiftool"
)

// Persistent exiftool instance (stay_open mode for performance).
// Initialized via InitExiftool(), shared across all indexing goroutines.
var (
	et     *exiftool.Exiftool
	etOnce sync.Once
	etMu   sync.Mutex
)

// InitExiftool starts the persistent exiftool process.
// Call once at startup. Uses -n (numeric), -G (group names), -struct.
func InitExiftool() error {
	var initErr error
	etOnce.Do(func() {
		var err error
		et, err = exiftool.NewExiftool(
			exiftool.NoPrintConversion(),
			exiftool.PrintGroupNames("0"),
			exiftool.Api("geolocation"),
		)
		if err != nil {
			initErr = fmt.Errorf("failed to initialize exiftool: %w", err)
		}
	})
	return initErr
}

// CloseExiftool shuts down the persistent exiftool process.
func CloseExiftool() {
	if et != nil {
		et.Close()
	}
}

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

// ExtractMetadata uses the persistent exiftool process to extract metadata.
// It returns a populated ExifData struct or an error.
func ExtractMetadata(filePath string) (*ExifData, error) {
	if et == nil {
		return nil, fmt.Errorf("exiftool not initialized (call InitExiftool first)")
	}

	etMu.Lock()
	fileInfos := et.ExtractMetadata(filePath)
	etMu.Unlock()

	if len(fileInfos) == 0 {
		return nil, fmt.Errorf("exiftool returned no results for %s", filePath)
	}

	fi := fileInfos[0]
	if fi.Err != nil {
		return nil, fmt.Errorf("exiftool error for %s: %w", filePath, fi.Err)
	}

	raw := fi.Fields
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
			data.Mediatype = "image"
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
	// Orientation: for images use EXIF:Orientation, for videos use Composite:Rotation
	if data.Mediatype == "video" {
		data.Orientation = getIntField(raw, "Composite:Rotation")
	} else {
		data.Orientation = getIntField(raw, "EXIF:Orientation")
	}

	// Calculate aspect ratio with orientation correction
	if data.ImageWidth != nil && data.ImageHeight != nil && *data.ImageHeight > 0 {
		w := float64(*data.ImageWidth)
		h := float64(*data.ImageHeight)

		if data.Mediatype == "image" {
			// Orientations 6 and 8 are 90/270 degree rotations that swap width and height
			if data.Orientation != nil && (*data.Orientation == 6 || *data.Orientation == 8) {
				w, h = h, w
			}
		} else if data.Mediatype == "video" {
			// Rotations 90 and 270 swap width and height
			if data.Orientation != nil && (*data.Orientation == 90 || *data.Orientation == 270) {
				w, h = h, w
			}
		}

		data.Aspectratio = math.Round(w/h*100) / 100
	}

	// Duration (video/audio)
	data.Duration = getFloatField(raw, "QuickTime:Duration", "EXIF:Duration")

	// GPS
	data.GPSLat = getFloatFieldRounded(raw, 6, "Composite:GPSLatitude", "EXIF:GPSLatitude")
	data.GPSLng = getFloatFieldRounded(raw, 6, "Composite:GPSLongitude", "EXIF:GPSLongitude")
	data.GPSAlt = getFloatField(raw, "Composite:GPSAltitude", "EXIF:GPSAltitude")

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

	// -------------------------------------------------------------------------
	// Capture date/time and timezone resolution
	// -------------------------------------------------------------------------
	// In Node.js, exiftool-vendored provides an ExifDateTime class that:
	//   1. Parses EXIF date strings into structured components (year, month, ...)
	//   2. Resolves the photographer's local timezone using GPS coordinates
	//      (via @photostructure/tz-lookup or exiftool's GeolocationTimeZone)
	//   3. Converts UTC-only dates (common in videos) to local time
	//   4. Exposes .tzoffsetMinutes for the UTC offset
	//
	// In Go, we replicate this behavior using exiftool's Composite tags:
	//
	//   Composite:SubSecDateTimeOriginal (or SubSecCreateDate)
	//     - exiftool combines the raw EXIF date + OffsetTimeOriginal (if present)
	//       OR derives the offset from GeolocationTimeZone (if -api geolocation is
	//       enabled and GPS coordinates exist)
	//     - Result: "2025:09:14 13:33:31.186-04:00" — local time with offset
	//     - For videos with only UTC dates and GPS, exiftool converts to local time
	//
	//   ExifTool:GeolocationTimeZone
	//     - IANA timezone name (e.g. "America/New_York") derived from GPS coords
	//     - Used by the frontend to display timezone abbreviations (EST, IST, etc.)
	//     - Requires exiftool 12.78+ with -api geolocation enabled
	//     - Note: with -G0, geolocation fields are in the "ExifTool" group (not "Composite")
	//
	// Fallback: if Composite dates are unavailable (old exiftool, no GPS), we use
	// raw EXIF:DateTimeOriginal which has no timezone info. In this case,
	// capture_tz_offset and capture_tz_name will be empty.
	//
	// The resulting fields stored in DB:
	//   captured_at       -> ISO 8601 string: "2025-09-14T13:33:31.186-04:00"
	//   capture_date      -> "2025-09-14" (derived in pipeline.go from CaptureDateTime)
	//   capture_time      -> "13:33:31"   (derived in pipeline.go from CaptureDateTime)
	//   capture_tz_offset -> "-04:00"     (derived in pipeline.go from CaptureDateTime.TzOffsetMinutes)
	//   capture_tz_name   -> "America/New_York" (from GeolocationTimeZone)
	// -------------------------------------------------------------------------

	data.ExifDatetimeOriginalRef = getStringField(raw, "EXIF:DateTimeOriginal")
	data.ExifCreateDateRef = getStringField(raw, "EXIF:CreateDate", "QuickTime:CreateDate")

	// Prefer Composite dates (include timezone) over raw EXIF dates
	compositeDate := getStringField(raw, "Composite:SubSecDateTimeOriginal", "Composite:SubSecCreateDate")
	if compositeDate != nil {
		// Convert exiftool format to ISO 8601: "2025:09:14 13:33:31.186-04:00" -> "2025-09-14T13:33:31.186-04:00"
		isoStr := exifDateToISO(*compositeDate)
		data.CapturedAt = &isoStr
		data.CaptureDateTime = parseCaptureDateTime(*compositeDate)
	} else {
		// Fallback to raw EXIF dates (no timezone info)
		dateStr := data.ExifDatetimeOriginalRef
		if dateStr == nil {
			dateStr = data.ExifCreateDateRef
		}
		if dateStr != nil {
			data.CapturedAt = dateStr
			data.CaptureDateTime = parseCaptureDateTime(*dateStr)
		}
	}

	// Timezone name: prefer GeolocationTimeZone (IANA name like "America/New_York")
	data.CaptureTzName = getStringField(raw, "ExifTool:GeolocationTimeZone")

	// Geolocation JSON from exiftool's built-in geolocation database
	// (requires exiftool 12.78+ with -api geolocation)
	geoFields := map[string]string{
		"GeolocationCity":        "ExifTool:GeolocationCity",
		"GeolocationRegion":      "ExifTool:GeolocationRegion",
		"GeolocationSubregion":   "ExifTool:GeolocationSubregion",
		"GeolocationCountryCode": "ExifTool:GeolocationCountryCode",
		"GeolocationCountry":     "ExifTool:GeolocationCountry",
		"GeolocationTimeZone":    "ExifTool:GeolocationTimeZone",
		"GeolocationFeatureCode": "ExifTool:GeolocationFeatureCode",
		"GeolocationFeatureType": "ExifTool:GeolocationFeatureType",
		"GeolocationPopulation":  "ExifTool:GeolocationPopulation",
		"GeolocationPosition":    "ExifTool:GeolocationPosition",
		"GeolocationDistance":    "ExifTool:GeolocationDistance",
		"GeolocationBearing":     "ExifTool:GeolocationBearing",
	}
	geoJSON := make(map[string]interface{})
	hasGeo := false
	for field, key := range geoFields {
		if v, ok := raw[key]; ok && v != nil {
			geoJSON[field] = v
			hasGeo = true
		} else {
			geoJSON[field] = nil
		}
	}
	if hasGeo {
		data.ExiftoolGeoJSON = geoJSON
	}

	// Timezone name from geolocation
	return data, nil
}

// WriteMetadata uses exiftool to write metadata fields to a file.
// Uses exec.Command for writes since they are infrequent and go-exiftool's
// write API is more limited.
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

// getFloatFieldRounded extracts a float value and rounds to the specified decimal places.
func getFloatFieldRounded(raw map[string]interface{}, decimals int, keys ...string) *float64 {
	val := getFloatField(raw, keys...)
	if val == nil {
		return nil
	}
	factor := math.Pow(10, float64(decimals))
	rounded := math.Round(*val*factor) / factor
	return &rounded
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

// exifDateToISO converts exiftool date format to ISO 8601.
// "2025:09:14 13:33:31.186-04:00" -> "2025-09-14T13:33:31.186-04:00"
// "2025:09:14 13:33:31" -> "2025-09-14T13:33:31"
func exifDateToISO(exifDate string) string {
	if len(exifDate) < 10 {
		return exifDate
	}
	// Replace first two colons in date portion with dashes
	iso := strings.Replace(exifDate, ":", "-", 2)
	// Replace the space between date and time with T
	iso = strings.Replace(iso, " ", "T", 1)
	return iso
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
