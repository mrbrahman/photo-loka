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
	"photo-loka/internal/queue"
)

// Geo resolution is package-level (single instance). geoLogger is the
// finalizer's logger; the geonames username is read from config.Startup.
func geoLogger() *slog.Logger { return slog.Default().With("component", "geo-finalizer") }

// FinalizeGeo is the main entry point for geo resolution.
// It derives missing fields from DB if needed, then routes to US vs non-US processing.
func FinalizeGeo(uuid string, gpsLat, gpsLng *float64, countryCode *string) error {
	// If we don't have GPS or country info, try to get it from DB
	if gpsLat == nil || gpsLng == nil || countryCode == nil {
		ctx, err := GetGeoContext(uuid)
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
		geoLogger().Debug("no GPS coordinates, skipping", "uuid", uuid)
		return UpdateGeoStatus(uuid, "NO_GPS")
	}

	// Route based on country
	var err error
	var resolveMethod string
	if countryCode != nil && *countryCode == "US" {
		resolveMethod = "US"
		err = finalizeUS(uuid, *gpsLat, *gpsLng)
	} else {
		resolveMethod = "non-US"
		err = finalizeNonUS(uuid)
	}

	if err != nil {
		return err
	}

	geoLogger().Info("geo finalized", "uuid", uuid, "method", resolveMethod)
	return nil
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

// finalizeUS attempts geo resolution for US addresses.
// Priority: exact match -> proximity match -> geonames API lookup.
func finalizeUS(uuid string, lat, lng float64) error {
	// Try exact coordinate match first
	match, err := FindExactGeoMatch(lat, lng)
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
			GeoStatus:      "FOUND_DB_EXACT_MATCH",
			GeoMatchedUUID: &matchedUUID,
		}
		return UpdateGeoFields(uuid, fields)
	}

	// Try proximity match (within 10m)
	match, err = FindProximityGeoMatch(lat, lng)
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
			GeoStatus:      "FOUND_DB_PROXIMITY_MATCH",
			GeoMatchedUUID: &matchedUUID,
		}
		return UpdateGeoFields(uuid, fields)
	}

	// Fall back to geonames API: hand off to the internal, rate-gated
	// address-API queue. The item's final address stays blank until that queue
	// (and possibly the city queue) completes; if the rate gate is closed the
	// item simply waits there until the rollover timer lifts it.
	return enqueueAddressLookup(uuid, lat, lng)
}

// enqueueAddressLookup places a findNearestAddress task on the internal
// address-API queue (concurrency 1, rate-gated). Separated so finalizeUS stays
// a pure local-phase decision: on a cache miss it just hands the item off.
func enqueueAddressLookup(uuid string, lat, lng float64) error {
	if addressQueue == nil {
		return fmt.Errorf("geo address queue not initialized (geo.Init not called)")
	}
	addressQueue.Enqueue(queue.Task{
		Priority:    queue.Normal,
		Description: "geo-address:" + uuid,
		Fn:          func() error { return addressLookupTask(uuid, lat, lng) },
	})
	return nil
}

// addressLookupTask is the body of an address-API queue task: it calls geonames
// findNearestAddress, writes the geo_lookups cache row (seeding the cache for
// nearby items), parses the result, and then EITHER writes the final address
// (terminal, when no city lookup is needed) OR hands the parsed address off to
// the city-API queue WITHOUT writing (2b: only the terminal step writes the
// item's final address).
//
// The "rate" gate on this queue keeps the task from dispatching while over
// budget; the atomic rateReserve here is the actual budget consumption and
// guards the (rare) race where the gate was open at dispatch but the budget was
// just exhausted by the sibling city queue. If the reserve is denied the task
// returns an error so the queue records it; the item is retried on the next
// explicit enqueue (counters reset hourly). It is NOT marked RATE_LIMITED.
func addressLookupTask(uuid string, lat, lng float64) error {
	if !rateReserve() {
		return fmt.Errorf("geonames budget exhausted for %s (address lookup); will retry after rollover", uuid)
	}

	apiURL := fmt.Sprintf(
		"http://api.geonames.org/findNearestAddressJSON?lat=%f&lng=%f&username=%s",
		lat, lng, url.QueryEscape(config.Startup.GeonamesUsername),
	)

	resp, err := http.Get(apiURL)
	if err != nil {
		return fmt.Errorf("geonames API call failed for %s: %w", uuid, err)
	}
	defer resp.Body.Close()

	SaveRateLimiter()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read geonames response for %s: %w", uuid, err)
	}

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("geonames API returned status %d for %s", resp.StatusCode, uuid)
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
		return fmt.Errorf("failed to parse geonames response for %s: %w", uuid, err)
	}

	// Extract address from response
	address, ok := result["address"].(map[string]interface{})
	if !ok {
		return UpdateGeoStatus(uuid, "NO_ADDRESS_FOUND")
	}

	// Decide whether a city lookup is needed: geonames findNearestAddress
	// sometimes returns an empty placename. When it does AND a postal code is
	// present, resolving the city needs a second API call -- hand off to the
	// city queue (2b: do not write the final address here). Otherwise this is
	// the terminal step and we write the final address now.
	placename, _ := address["placename"].(string)
	postalcode, _ := address["postalcode"].(string)
	if placename == "" && postalcode != "" {
		return enqueueCityLookup(uuid, address)
	}

	// placename present (or no postal code to resolve from): terminal write.
	return writeFinalAddress(uuid, address, placename, "FOUND_VIA_API", nil)
}

// enqueueCityLookup hands the parsed address to the city-API queue. The parsed
// address object is carried forward in the closure (2b): the final address is
// written only by the terminal city task, not here.
func enqueueCityLookup(uuid string, address map[string]interface{}) error {
	if cityQueue == nil {
		return fmt.Errorf("geo city queue not initialized (geo.Init not called)")
	}
	cityQueue.Enqueue(queue.Task{
		Priority:    queue.Normal,
		Description: "geo-city:" + uuid,
		Fn:          func() error { return cityLookupTask(uuid, address) },
	})
	return nil
}

// cityLookupTask is the body of a city-API queue task (terminal): it resolves
// the city from the postal code (DB cache first, then geonames postalCodeLookup
// behind the atomic reserve) and writes the final address. It receives the
// already-parsed address from the address task.
func cityLookupTask(uuid string, address map[string]interface{}) error {
	postalcode, _ := address["postalcode"].(string)
	countryCode := "US"
	if cc, ok := address["countryCode"].(string); ok && cc != "" {
		countryCode = cc
	}

	city, err := resolveCity(uuid, postalcode, countryCode)
	if err != nil {
		return err
	}
	// Terminal write. city may be "" if the postal lookup yielded nothing; the
	// address builder then falls back to the county (adminName2), as before.
	return writeFinalAddress(uuid, address, city, "FOUND_VIA_API", nil)
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

// resolveCity attempts to find a city name from a postal code. It first checks
// the DB cache, then calls the geonames postalCodeLookup API behind the atomic
// rateReserve. It no longer does its own rate GATE check (the city-API queue's
// "rate" gate handles that at dispatch); the reserve here is the budget
// consumption and guards the last-unit race between the two queues. On an
// exhausted budget it returns "" (no city) so the caller falls back to the
// county, rather than retrying mid-task.
func resolveCity(uuid, postalcode, country string) (string, error) {
	// Check cache first
	responseJSON, err := FindPostalCodeMatch(postalcode, country)
	if err != nil {
		return "", err
	}

	if responseJSON != "" {
		return extractCityFromPostalResponse(responseJSON)
	}

	// Consume one budget unit for the postalCodeLookup call. If denied (the
	// sibling address queue took the last unit between this task's gate check
	// and here), skip the city call and let the caller use the county fallback.
	if !rateReserve() {
		geoLogger().Warn("geonames budget exhausted before city lookup; using county fallback", "uuid", uuid)
		return "", nil
	}

	apiURL := fmt.Sprintf(
		"http://api.geonames.org/postalCodeLookupJSON?postalcode=%s&country=%s&username=%s",
		url.QueryEscape(postalcode), url.QueryEscape(country), url.QueryEscape(config.Startup.GeonamesUsername),
	)

	resp, err := http.Get(apiURL)
	if err != nil {
		return "", fmt.Errorf("postal code lookup failed: %w", err)
	}
	defer resp.Body.Close()

	SaveRateLimiter()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read postal code response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("postal code API returned status %d", resp.StatusCode)
	}

	responseStr := string(body)
	requestParams := fmt.Sprintf(`{"postalcode":"%s","country":"%s"}`, postalcode, country)

	// Store the lookup
	if err := InsertGeoLookup(uuid, "geonames", "postalCodeLookup", &requestParams, &responseStr); err != nil {
		geoLogger().Error("failed to insert postal code lookup", "uuid", uuid, "error", err)
	}

	return extractCityFromPostalResponse(responseStr)
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
