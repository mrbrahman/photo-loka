package geo

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
)

// Finalizer handles geo resolution logic for media items.
type Finalizer struct {
	db           *GeoDB
	rateLimiter  *RateLimiter
	geonamesUser string
	logger       *slog.Logger
}

// NewFinalizer creates a new Finalizer instance.
func NewFinalizer(db *GeoDB, rl *RateLimiter, geonamesUser string) *Finalizer {
	return &Finalizer{
		db:           db,
		rateLimiter:  rl,
		geonamesUser: geonamesUser,
		logger:       slog.Default().With("component", "geo-finalizer"),
	}
}

// FinalizeGeo is the main entry point for geo resolution.
// It derives missing fields from DB if needed, then routes to US vs non-US processing.
func (f *Finalizer) FinalizeGeo(uuid string, gpsLat, gpsLng *float64, countryCode *string) error {
	// If we don't have GPS or country info, try to get it from DB
	if gpsLat == nil || gpsLng == nil || countryCode == nil {
		ctx, err := f.db.GetGeoContext(uuid)
		if err != nil {
			return fmt.Errorf("failed to get geo context for %s: %w", uuid, err)
		}
		if gpsLat == nil {
			gpsLat = ctx.GPSLat
		}
		if gpsLng == nil {
			gpsLng = ctx.GPSLng
		}
		if countryCode == nil {
			countryCode = ctx.CountryCode
		}
	}

	// No GPS coordinates - nothing we can do
	if gpsLat == nil || gpsLng == nil {
		return f.db.UpdateGeoStatus(uuid, "no_gps")
	}

	// Route based on country
	if countryCode != nil && *countryCode == "US" {
		return f.finalizeUS(uuid, *gpsLat, *gpsLng)
	}

	return f.finalizeNonUS(uuid)
}

// finalizeNonUS reads exiftool geo data from DB and builds address fields.
func (f *Finalizer) finalizeNonUS(uuid string) error {
	responseJSON, err := f.db.GetExiftoolGeoLookup(uuid)
	if err != nil {
		return fmt.Errorf("failed to get exiftool geo lookup for %s: %w", uuid, err)
	}

	if responseJSON == "" {
		return f.db.UpdateGeoStatus(uuid, "no_exiftool_data")
	}

	var data map[string]interface{}
	if err := json.Unmarshal([]byte(responseJSON), &data); err != nil {
		return fmt.Errorf("failed to parse exiftool geo JSON for %s: %w", uuid, err)
	}

	// Build address string from available fields (matching Node.js geo-finalizer format)
	var parts []string
	for _, key := range []string{"GeolocationCity", "GeolocationSubregion", "GeolocationRegion", "GeolocationCountryCode", "GeolocationCountry"} {
		if v, ok := data[key]; ok && v != nil {
			if s, ok := v.(string); ok && s != "" {
				parts = append(parts, s)
			}
		}
	}

	geoAddress := strings.Join(parts, ", ")
	if geoAddress == "" {
		return f.db.UpdateGeoStatus(uuid, "no_address_data")
	}

	var city, region, country, countryCode *string
	if v, ok := data["GeolocationCity"].(string); ok && v != "" {
		city = &v
	}
	if v, ok := data["GeolocationRegion"].(string); ok && v != "" {
		region = &v
	}
	if v, ok := data["GeolocationCountry"].(string); ok && v != "" {
		country = &v
	}
	if v, ok := data["GeolocationCountryCode"].(string); ok && v != "" {
		countryCode = &v
	}

	fields := &GeoFields{
		GeoAddress:     &geoAddress,
		GeoCity:        city,
		GeoRegion:      region,
		GeoCountry:     country,
		GeoCountryCode: countryCode,
		GeoStatus:      "done_exiftool",
	}

	return f.db.UpdateGeoFields(uuid, fields)
}

// finalizeUS attempts geo resolution for US addresses.
// Priority: exact match -> proximity match -> geonames API lookup.
func (f *Finalizer) finalizeUS(uuid string, lat, lng float64) error {
	// Try exact coordinate match first
	match, err := f.db.FindExactGeoMatch(lat, lng)
	if err != nil {
		return fmt.Errorf("exact geo match failed for %s: %w", uuid, err)
	}
	if match != nil {
		matchedUUID := match.UUID
		fields := &GeoFields{
			GeoAddress:     &match.GeoAddress,
			GeoCity:        match.GeoCity,
			GeoRegion:      match.GeoRegion,
			GeoCountry:     match.GeoCountry,
			GeoCountryCode: match.GeoCountryCode,
			GeoStatus:      "done_exact_match",
			GeoMatchedUUID: &matchedUUID,
		}
		return f.db.UpdateGeoFields(uuid, fields)
	}

	// Try proximity match (within 10m)
	match, err = f.db.FindProximityGeoMatch(lat, lng)
	if err != nil {
		return fmt.Errorf("proximity geo match failed for %s: %w", uuid, err)
	}
	if match != nil {
		matchedUUID := match.UUID
		fields := &GeoFields{
			GeoAddress:     &match.GeoAddress,
			GeoCity:        match.GeoCity,
			GeoRegion:      match.GeoRegion,
			GeoCountry:     match.GeoCountry,
			GeoCountryCode: match.GeoCountryCode,
			GeoStatus:      "done_proximity_match",
			GeoMatchedUUID: &matchedUUID,
		}
		return f.db.UpdateGeoFields(uuid, fields)
	}

	// Fall back to geonames API
	return f.lookupGeonames(uuid, lat, lng)
}

// lookupGeonames calls the geonames findNearestAddressJSON API and stores the result.
func (f *Finalizer) lookupGeonames(uuid string, lat, lng float64) error {
	if !f.rateLimiter.Check() {
		return f.db.UpdateGeoStatus(uuid, "rate_limited")
	}

	apiURL := fmt.Sprintf(
		"http://api.geonames.org/findNearestAddressJSON?lat=%f&lng=%f&username=%s",
		lat, lng, url.QueryEscape(f.geonamesUser),
	)

	resp, err := http.Get(apiURL)
	if err != nil {
		return fmt.Errorf("geonames API call failed for %s: %w", uuid, err)
	}
	defer resp.Body.Close()

	f.rateLimiter.Increment()
	f.rateLimiter.Save()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read geonames response for %s: %w", uuid, err)
	}

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("geonames API returned status %d for %s", resp.StatusCode, uuid)
	}

	responseStr := string(body)
	requestParams := fmt.Sprintf("lat=%f&lng=%f", lat, lng)

	// Store the lookup result
	if err := f.db.InsertGeoLookup(uuid, "geonames", "findNearestAddressJSON", &requestParams, &responseStr); err != nil {
		f.logger.Error("failed to insert geo lookup", "uuid", uuid, "error", err)
	}

	// Parse the response
	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("failed to parse geonames response for %s: %w", uuid, err)
	}

	// Extract address from response
	address, ok := result["address"].(map[string]interface{})
	if !ok {
		return f.db.UpdateGeoStatus(uuid, "no_address_in_response")
	}

	return f.resolveFromAddress(uuid, address, "done_geonames", nil)
}

// resolveFromAddress builds geo fields from a parsed address object and updates the DB.
func (f *Finalizer) resolveFromAddress(uuid string, address map[string]interface{}, status string, matchedUUID *string) error {
	// Build address string from street, city, state
	var parts []string
	if street, ok := address["street"].(string); ok && street != "" {
		if streetNumber, ok := address["streetNumber"].(string); ok && streetNumber != "" {
			parts = append(parts, streetNumber+" "+street)
		} else {
			parts = append(parts, street)
		}
	}

	cityStr := ""
	if city, ok := address["placename"].(string); ok && city != "" {
		parts = append(parts, city)
		cityStr = city
	}

	regionStr := ""
	if region, ok := address["adminName1"].(string); ok && region != "" {
		parts = append(parts, region)
		regionStr = region
	}

	geoAddress := strings.Join(parts, ", ")

	// If we have a postal code but no city, try to resolve it
	if cityStr == "" {
		if postalcode, ok := address["postalcode"].(string); ok && postalcode != "" {
			countryCode := "US"
			if cc, ok := address["countryCode"].(string); ok && cc != "" {
				countryCode = cc
			}
			resolvedCity, err := f.resolveCity(uuid, postalcode, countryCode)
			if err == nil && resolvedCity != "" {
				cityStr = resolvedCity
			}
		}
	}

	var city, region, country, countryCode *string
	if cityStr != "" {
		city = &cityStr
	}
	if regionStr != "" {
		region = &regionStr
	}
	if c, ok := address["countryCode"].(string); ok && c != "" {
		countryCode = &c
	}
	countryStr := "United States"
	country = &countryStr

	fields := &GeoFields{
		GeoAddress:     &geoAddress,
		GeoCity:        city,
		GeoRegion:      region,
		GeoCountry:     country,
		GeoCountryCode: countryCode,
		GeoStatus:      status,
		GeoMatchedUUID: matchedUUID,
	}

	return f.db.UpdateGeoFields(uuid, fields)
}

// resolveCity attempts to find a city name from a postal code.
// It first checks the DB cache, then calls the geonames postalCodeLookup API.
func (f *Finalizer) resolveCity(uuid, postalcode, country string) (string, error) {
	// Check cache first
	responseJSON, err := f.db.FindPostalCodeMatch(postalcode, country)
	if err != nil {
		return "", err
	}

	if responseJSON != "" {
		return f.extractCityFromPostalResponse(responseJSON)
	}

	// Call geonames API
	if !f.rateLimiter.Check() {
		return "", fmt.Errorf("rate limited")
	}

	apiURL := fmt.Sprintf(
		"http://api.geonames.org/postalCodeLookupJSON?postalcode=%s&country=%s&username=%s",
		url.QueryEscape(postalcode), url.QueryEscape(country), url.QueryEscape(f.geonamesUser),
	)

	resp, err := http.Get(apiURL)
	if err != nil {
		return "", fmt.Errorf("postal code lookup failed: %w", err)
	}
	defer resp.Body.Close()

	f.rateLimiter.Increment()
	f.rateLimiter.Save()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read postal code response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("postal code API returned status %d", resp.StatusCode)
	}

	responseStr := string(body)
	requestParams := fmt.Sprintf("postalcode=%s&country=%s", postalcode, country)

	// Store the lookup
	if err := f.db.InsertGeoLookup(uuid, "geonames", "postalCodeLookup", &requestParams, &responseStr); err != nil {
		f.logger.Error("failed to insert postal code lookup", "uuid", uuid, "error", err)
	}

	return f.extractCityFromPostalResponse(responseStr)
}

// extractCityFromPostalResponse extracts the city/placeName from a postal code lookup response.
func (f *Finalizer) extractCityFromPostalResponse(responseJSON string) (string, error) {
	var result map[string]interface{}
	if err := json.Unmarshal([]byte(responseJSON), &result); err != nil {
		return "", err
	}

	postalCodes, ok := result["postalcodes"].([]interface{})
	if !ok || len(postalCodes) == 0 {
		return "", nil
	}

	first, ok := postalCodes[0].(map[string]interface{})
	if !ok {
		return "", nil
	}

	if placeName, ok := first["placeName"].(string); ok {
		return placeName, nil
	}

	return "", nil
}
