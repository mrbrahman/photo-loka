package media

import (
	"encoding/json"
	"fmt"
	"math"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	exiftool "github.com/barasher/go-exiftool"

	"photo-loka/internal/utils"
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

	// exif_*_ref fields: render the timezone-aware Composite SubSec values as
	// ISO-8601 via the shared exifdate helper (matching the Node.js server,
	// which renders these from exiftool-vendored ExifDateTime objects with
	// subseconds + offset). Fall back to the plain EXIF/QuickTime fields when
	// the Composite SubSec variant is absent.
	data.ExifDatetimeOriginalRef = refDateISO(raw, "Composite:SubSecDateTimeOriginal", "EXIF:DateTimeOriginal")
	data.ExifCreateDateRef = refDateISO(raw, "Composite:SubSecCreateDate", "EXIF:CreateDate", "QuickTime:CreateDate")

	// captured_at / CaptureDateTime: prefer the Composite SubSec value (carries
	// the resolved timezone offset and subseconds), falling back to the plain
	// EXIF dates (no timezone) when unavailable.
	captureSrc := getStringField(raw, "Composite:SubSecDateTimeOriginal", "Composite:SubSecCreateDate",
		"EXIF:DateTimeOriginal", "EXIF:CreateDate", "QuickTime:CreateDate")
	if captureSrc != nil {
		if dt, ok := utils.ParseExifDate(*captureSrc); ok {
			iso := dt.ToISO()
			data.CapturedAt = &iso
			data.CaptureDateTime = toCaptureDateTime(dt)
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

// refDateISO renders the first present field (searched in order) as an
// ISO-8601 string via the shared exifdate helper, or nil if none parse.
func refDateISO(raw map[string]interface{}, fields ...string) *string {
	src := getStringField(raw, fields...)
	if src == nil {
		return nil
	}
	dt, ok := utils.ParseExifDate(*src)
	if !ok {
		return nil
	}
	iso := dt.ToISO()
	return &iso
}

// toCaptureDateTime maps a parsed utils.ExifDateTime into the media
// CaptureDateTime struct used by the organizer for folder placement.
func toCaptureDateTime(dt utils.ExifDateTime) *CaptureDateTime {
	return &CaptureDateTime{
		Year:            dt.Year,
		Month:           dt.Month,
		Day:             dt.Day,
		Hour:            dt.Hour,
		Minute:          dt.Minute,
		Second:          dt.Second,
		TzOffsetMinutes: dt.TzOffsetMinutes,
	}
}
