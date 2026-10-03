package geo

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"photo-loka/internal/config"
)

// Geo resolution is split into phases run by three pipeline queues (geo-cache,
// geo-lookup-addr, geo-lookup-city). The LOCAL phase (ResolveLocal) does GPS
// derivation, non-US resolution, and US DB cache lookups -- all terminal except
// a US cache miss, which signals the pipeline to route to the API phases. The
// API phases (LookupAddress, LookupCity) are rate-gated by the geo rate gater
// and are the only ones that call geonames. geoLogger is the finalizer's
// logger; the geonames username is read from config.Startup.
func geoLogger() *slog.Logger { return slog.Default().With("component", "geo-finalizer") }

// ResolveLocal runs the local (no-API) phase of geo resolution for a uuid:
// derive GPS/country from the DB when not supplied, then resolve non-US items
// from exiftool data or US items from the DB cache (exact then proximity). All
// of those are terminal (it writes the final address and returns needsAPI
// false). Only a US cache MISS returns needsAPI true with the lat/lng the
// pipeline then routes to the geo-lookup-addr queue. This is the former
// FinalizeGeo minus the geonames handoff.
func ResolveLocal(uuid string, gpsLat, gpsLng *float64, countryCode *string) (needsAPI bool, lat, lng float64, err error) {
	// If we don't have GPS or country info, try to get it from DB
	if gpsLat == nil || gpsLng == nil || countryCode == nil {
		ctx, cerr := GetGeoContext(uuid)
		if cerr != nil {
			return false, 0, 0, fmt.Errorf("failed to get geo context for %s: %w", uuid, cerr)
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
		geoLogger().Debug("no GPS coordinates, skipping", "uuid", uuid)
		return false, 0, 0, UpdateGeoStatus(uuid, "NO_GPS")
	}

	// Non-US: resolve from exiftool data (terminal, no API).
	if countryCode == nil || *countryCode != "US" {
		return false, 0, 0, finalizeNonUS(uuid)
	}

	// US: try the DB cache (exact then proximity). A hit is terminal; a miss
	// signals the pipeline to route to the API phase with these coordinates.
	resolved, rerr := resolveUSFromCache(uuid, *gpsLat, *gpsLng)
	if rerr != nil {
		return false, 0, 0, rerr
	}
	if resolved {
		return false, 0, 0, nil
	}
	return true, *gpsLat, *gpsLng, nil
}

// finalizeNonUS reads exiftool geo data from DB and builds address fields.
func finalizeNonUS(uuid string) error {
	responseJSON, err := GetExiftoolGeoLookup(uuid)
	if err != nil {
		return fmt.Errorf("failed to get exiftool geo lookup for %s: %w", uuid, err)
	}

	if responseJSON == "" {
		return UpdateGeoStatus(uuid, "NO_EXIFTOOL_DATA")
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
		return UpdateGeoStatus(uuid, "NO_ADDRESS_DATA")
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
		GeoStatus:      "RESOLVED_FROM_EXIFTOOL",
	}

	return UpdateGeoFields(uuid, fields)
}

// resolveUSFromCache tries the US DB cache: exact coordinate match, then
// proximity match (within 10m). On a hit it writes the final address and
// returns resolved=true. On a miss it returns resolved=false (no API call --
// the pipeline routes to the API phase). No geonames calls happen here.
func resolveUSFromCache(uuid string, lat, lng float64) (resolved bool, err error) {
	// Try exact coordinate match first
	match, err := FindExactGeoMatch(lat, lng)
	if err != nil {
		return false, fmt.Errorf("exact geo match failed for %s: %w", uuid, err)
	}
	if match != nil {
		matchedUUID := match.UUID
		fields := &GeoFields{
			GeoAddress:     &match.GeoAddress,
			GeoCity:        match.GeoCity,
			GeoRegion:      match.GeoRegion,
			GeoCountry:     match.GeoCountry,
			GeoCountryCode: match.GeoCountryCode,
			GeoStatus:      "FOUND_DB_EXACT_MATCH",
			GeoMatchedUUID: &matchedUUID,
		}
		return true, UpdateGeoFields(uuid, fields)
	}

	// Try proximity match (within 10m)
	match, err = FindProximityGeoMatch(lat, lng)
	if err != nil {
		return false, fmt.Errorf("proximity geo match failed for %s: %w", uuid, err)
	}
	if match != nil {
		matchedUUID := match.UUID
		fields := &GeoFields{
			GeoAddress:     &match.GeoAddress,
			GeoCity:        match.GeoCity,
			GeoRegion:      match.GeoRegion,
			GeoCountry:     match.GeoCountry,
			GeoCountryCode: match.GeoCountryCode,
			GeoStatus:      "FOUND_DB_PROXIMITY_MATCH",
			GeoMatchedUUID: &matchedUUID,
		}
		return true, UpdateGeoFields(uuid, fields)
	}

	// Cache miss: the caller (pipeline) routes to the geonames API phase.
	return false, nil
}

// LookupAddress is the geo-lookup-addr phase: it calls geonames
// findNearestAddress for a US cache miss, writes the geo_lookups cache row
// (seeding the cache for nearby items), parses the result, and EITHER writes
// the final address (terminal, needsCity=false) OR returns needsCity=true with
// the parsed address serialized as JSON (parsedAddr) so the pipeline can route
// to the geo-lookup-city phase WITHOUT a final write here (2b).
//
// Rate limiting is NOT geo's concern: the caller (the geo-lookup-addr stage
// function) reserves a budget unit via the geo rate gater before invoking this,
// and the queue's "rate" gate holds dispatch while over budget. geo just makes
// the call.
func LookupAddress(uuid string, lat, lng float64) (needsCity bool, parsedAddr string, err error) {
	apiURL := fmt.Sprintf(
		"http://api.geonames.org/findNearestAddressJSON?lat=%f&lng=%f&username=%s",
		lat, lng, url.QueryEscape(config.Startup.GeonamesUsername),
	)

	resp, err := http.Get(apiURL)
	if err != nil {
		return false, "", fmt.Errorf("geonames API call failed for %s: %w", uuid, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, "", fmt.Errorf("failed to read geonames response for %s: %w", uuid, err)
	}

	if resp.StatusCode != http.StatusOK {
		return false, "", fmt.Errorf("geonames API returned status %d for %s", resp.StatusCode, uuid)
	}

	responseStr := string(body)
	requestParams := fmt.Sprintf(`{"lat":%f,"lng":%f}`, lat, lng)

	// Store the lookup result (cache seed). This write happens even in the 2b
	// handoff case -- it is the geo_lookups cache row, not the item's final
	// address fields.
	if err := InsertGeoLookup(uuid, "geonames", "findNearestAddress", &requestParams, &responseStr); err != nil {
		geoLogger().Error("failed to insert geo lookup", "uuid", uuid, "error", err)
	}

	// Parse the response
	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return false, "", fmt.Errorf("failed to parse geonames response for %s: %w", uuid, err)
	}

	// Extract address from response
	address, ok := result["address"].(map[string]interface{})
	if !ok {
		return false, "", UpdateGeoStatus(uuid, "NO_ADDRESS_FOUND")
	}

	// Decide whether a city lookup is needed: geonames findNearestAddress
	// sometimes returns an empty placename. When it does AND a postal code is
	// present, resolving the city needs a second API call -- signal the pipeline
	// to route to the city phase (2b: do not write the final address here),
	// carrying the parsed address as JSON. Otherwise this is terminal.
	placename, _ := address["placename"].(string)
	postalcode, _ := address["postalcode"].(string)
	if placename == "" && postalcode != "" {
		enc, merr := json.Marshal(address)
		if merr != nil {
			return false, "", fmt.Errorf("marshaling parsed address for %s: %w", uuid, merr)
		}
		return true, string(enc), nil
	}

	// placename present (or no postal code to resolve from): terminal write.
	return false, "", writeFinalAddress(uuid, address, placename, "FOUND_VIA_API", nil)
}

// ResolveCityFromCache is the LOCAL city-resolution step (no API): it parses the
// carried address and checks the postal-code DB cache. Returns the city and
// found=true on a cache hit, or found=false on a miss (the caller -- the
// geo-city-cache stage -- then routes to the geo-lookup-city API stage). Used so
// a cache hit never consumes a geonames budget unit.
func ResolveCityFromCache(parsedAddr string) (city string, found bool, err error) {
	postalcode, country, _, perr := parseCityInputs(parsedAddr)
	if perr != nil {
		return "", false, perr
	}
	responseJSON, err := FindPostalCodeMatch(postalcode, country)
	if err != nil {
		return "", false, err
	}
	if responseJSON == "" {
		return "", false, nil
	}
	c, err := extractCityFromPostalResponse(responseJSON)
	if err != nil {
		return "", false, err
	}
	return c, true, nil
}

// WriteCityAddress writes the final address using a city already resolved from
// the cache (the geo-city-cache terminal path). No API call.
func WriteCityAddress(uuid, parsedAddr, city string) error {
	var address map[string]interface{}
	if err := json.Unmarshal([]byte(parsedAddr), &address); err != nil {
		return fmt.Errorf("parsing carried address for %s: %w", uuid, err)
	}
	return writeFinalAddress(uuid, address, city, "FOUND_VIA_API", nil)
}

// LookupCity is the geo-lookup-city phase: a pure geonames postalCodeLookup API
// call (the postal cache already missed in geo-city-cache) that resolves the
// city and writes the final address. Rate limiting is the queue's concern (the
// consuming "rate" gate reserved a unit before this launched), so there is no
// rate handling here -- and because the cache miss is already established, this
// always makes exactly one API call.
func LookupCity(uuid, parsedAddr string) error {
	var address map[string]interface{}
	if err := json.Unmarshal([]byte(parsedAddr), &address); err != nil {
		return fmt.Errorf("parsing carried address for %s: %w", uuid, err)
	}
	postalcode, country, _, _ := parseCityInputs(parsedAddr)

	city, err := lookupCityAPI(uuid, postalcode, country)
	if err != nil {
		return err
	}
	// Terminal write. city may be "" if the postal lookup yielded nothing; the
	// address builder then falls back to the county (adminName2), as before.
	return writeFinalAddress(uuid, address, city, "FOUND_VIA_API", nil)
}

// parseCityInputs extracts the postalcode and country from a parsed address
// JSON (country defaults to US). Shared by the cache and API city paths.
func parseCityInputs(parsedAddr string) (postalcode, country string, address map[string]interface{}, err error) {
	if err = json.Unmarshal([]byte(parsedAddr), &address); err != nil {
		return "", "", nil, fmt.Errorf("parsing carried address: %w", err)
	}
	postalcode, _ = address["postalcode"].(string)
	country = "US"
	if cc, ok := address["countryCode"].(string); ok && cc != "" {
		country = cc
	}
	return postalcode, country, address, nil
}

// lookupCityAPI calls the geonames postalCodeLookup API for a postal code,
// stores the response (cache seed), and returns the resolved city. Pure API: no
// cache check (the caller established the miss) and no rate handling.
func lookupCityAPI(uuid, postalcode, country string) (string, error) {
	apiURL := fmt.Sprintf(
		"http://api.geonames.org/postalCodeLookupJSON?postalcode=%s&country=%s&username=%s",
		url.QueryEscape(postalcode), url.QueryEscape(country), url.QueryEscape(config.Startup.GeonamesUsername),
	)

	resp, err := http.Get(apiURL)
	if err != nil {
		return "", fmt.Errorf("postal code lookup failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read postal code response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("postal code API returned status %d", resp.StatusCode)
	}

	responseStr := string(body)
	requestParams := fmt.Sprintf(`{"postalcode":"%s","country":"%s"}`, postalcode, country)

	// Store the lookup (cache seed).
	if err := InsertGeoLookup(uuid, "geonames", "postalCodeLookup", &requestParams, &responseStr); err != nil {
		geoLogger().Error("failed to insert postal code lookup", "uuid", uuid, "error", err)
	}

	return extractCityFromPostalResponse(responseStr)
}

// writeFinalAddress builds the geo fields from a parsed address object plus a
// resolved city (possibly empty) and writes the item's final address. This is
// the single terminal write shared by the address task (no-city case) and the
// city task. It is the former resolveFromAddress with the city already decided
// (no inline API call), so the two-call budget is enforced by the two queues'
// gates/reserves rather than an inner rate check.
func writeFinalAddress(uuid string, address map[string]interface{}, cityStr, status string, matchedUUID *string) error {
	regionStr := ""
	if region, ok := address["adminName1"].(string); ok && region != "" {
		regionStr = region
	}

	// Build address string matching Node.js format:
	// [streetNumber, street, city || adminName2, adminName1, countryCode]
	var parts []string
	if streetNumber, ok := address["streetNumber"].(string); ok && streetNumber != "" {
		parts = append(parts, streetNumber)
	}
	if street, ok := address["street"].(string); ok && street != "" {
		parts = append(parts, street)
	}

	if cityStr != "" {
		parts = append(parts, cityStr)
	} else if county, ok := address["adminName2"].(string); ok && county != "" {
		// Fall back to county only when no city could be resolved.
		parts = append(parts, county)
	}

	if regionStr != "" {
		parts = append(parts, regionStr)
	}

	if cc, ok := address["countryCode"].(string); ok && cc != "" {
		parts = append(parts, cc)
	}

	geoAddress := strings.Join(parts, ", ")

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

	return UpdateGeoFields(uuid, fields)
}

// extractCityFromPostalResponse extracts the city/placeName from a postal code lookup response.
func extractCityFromPostalResponse(responseJSON string) (string, error) {
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
