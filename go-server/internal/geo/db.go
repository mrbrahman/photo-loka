package geo

import (
	"database/sql"
	"math"
)

// GeoDB handles database operations for geo encoding.
type GeoDB struct {
	db *sql.DB
}

// GeoContext holds GPS coordinates and country code for a media item.
type GeoContext struct {
	GPSLat      *float64
	GPSLng      *float64
	CountryCode *string
}

// GeoMatch represents a matched geo record from a nearby item.
type GeoMatch struct {
	UUID           string
	GeoAddress     string
	GeoCity        *string
	GeoRegion      *string
	GeoCountry     *string
	GeoCountryCode *string
}

// GeoFields holds the fields to update for a geo-resolved item.
type GeoFields struct {
	GeoAddress     *string
	GeoCity        *string
	GeoRegion      *string
	GeoCountry     *string
	GeoCountryCode *string
	GeoStatus      string
	GeoMatchedUUID *string
}

// NewGeoDB creates a new GeoDB instance.
func NewGeoDB(conn *sql.DB) *GeoDB {
	return &GeoDB{db: conn}
}

// GetGeoContext retrieves GPS coordinates and country code for a given uuid.
func (g *GeoDB) GetGeoContext(uuid string) (*GeoContext, error) {
	ctx := &GeoContext{}
	err := g.db.QueryRow(
		`SELECT gps_lat, gps_lng, country_code FROM metadata WHERE uuid = ?`,
		uuid,
	).Scan(&ctx.GPSLat, &ctx.GPSLng, &ctx.CountryCode)
	if err != nil {
		return nil, err
	}
	return ctx, nil
}

// GetExiftoolGeoLookup returns the stored exiftool geo lookup response_json for a uuid.
// Returns empty string if no record found.
func (g *GeoDB) GetExiftoolGeoLookup(uuid string) (string, error) {
	var responseJSON sql.NullString
	err := g.db.QueryRow(
		`SELECT response_json FROM geo_lookups
		 WHERE uuid = ? AND source = 'exiftool' AND api_name = 'geolocation'`,
		uuid,
	).Scan(&responseJSON)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if responseJSON.Valid {
		return responseJSON.String, nil
	}
	return "", nil
}

// FindExactGeoMatch finds a previously resolved item at the same GPS coordinates
// (rounded to 4 decimal places).
func (g *GeoDB) FindExactGeoMatch(lat, lng float64) (*GeoMatch, error) {
	roundedLat := math.Round(lat*10000) / 10000
	roundedLng := math.Round(lng*10000) / 10000

	match := &GeoMatch{}
	err := g.db.QueryRow(
		`SELECT uuid, geo_address, geo_city, geo_region, geo_country, geo_country_code
		 FROM metadata
		 WHERE ROUND(gps_lat, 4) = ROUND(?, 4)
		   AND ROUND(gps_lng, 4) = ROUND(?, 4)
		   AND geo_address IS NOT NULL
		 LIMIT 1`,
		roundedLat, roundedLng,
	).Scan(&match.UUID, &match.GeoAddress, &match.GeoCity, &match.GeoRegion, &match.GeoCountry, &match.GeoCountryCode)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return match, nil
}

// FindProximityGeoMatch finds a previously resolved item within 10 meters
// using the haversine formula.
func (g *GeoDB) FindProximityGeoMatch(lat, lng float64) (*GeoMatch, error) {
	// Haversine formula in SQL - distance in meters
	// 6371000 = earth radius in meters
	query := `
		SELECT uuid, geo_address, geo_city, geo_region, geo_country, geo_country_code
		FROM metadata
		WHERE geo_address IS NOT NULL
		  AND gps_lat IS NOT NULL
		  AND gps_lng IS NOT NULL
		  AND (
		    6371000 * 2 * ASIN(SQRT(
		      POWER(SIN((RADIANS(gps_lat) - RADIANS(?)) / 2), 2) +
		      COS(RADIANS(?)) * COS(RADIANS(gps_lat)) *
		      POWER(SIN((RADIANS(gps_lng) - RADIANS(?)) / 2), 2)
		    ))
		  ) < 10
		LIMIT 1`

	match := &GeoMatch{}
	err := g.db.QueryRow(query, lat, lat, lng).Scan(
		&match.UUID, &match.GeoAddress, &match.GeoCity, &match.GeoRegion, &match.GeoCountry, &match.GeoCountryCode,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return match, nil
}

// FindPostalCodeMatch returns the response_json from geo_lookups for a postal code + country match.
func (g *GeoDB) FindPostalCodeMatch(postalcode, country string) (string, error) {
	var responseJSON sql.NullString
	err := g.db.QueryRow(
		`SELECT response_json FROM geo_lookups
		 WHERE api_name = 'postalCodeLookup'
		   AND request_params LIKE '%' || ? || '%'
		   AND request_params LIKE '%' || ? || '%'
		 LIMIT 1`,
		postalcode, country,
	).Scan(&responseJSON)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if responseJSON.Valid {
		return responseJSON.String, nil
	}
	return "", nil
}

// InsertGeoLookup inserts a record into the geo_lookups table.
func (g *GeoDB) InsertGeoLookup(uuid, source, apiName string, requestParams, responseJSON *string) error {
	_, err := g.db.Exec(
		`INSERT INTO geo_lookups (uuid, source, api_name, request_params, response_json)
		 VALUES (?, ?, ?, ?, ?)`,
		uuid, source, apiName, requestParams, responseJSON,
	)
	return err
}

// UpdateGeoFields updates geo-related fields on the metadata table.
// Uses COALESCE for country and country_code to avoid overwriting existing values with NULL.
func (g *GeoDB) UpdateGeoFields(uuid string, fields *GeoFields) error {
	_, err := g.db.Exec(
		`UPDATE metadata SET
		   geo_address = ?,
		   geo_city = ?,
		   geo_region = ?,
		   geo_country = COALESCE(?, geo_country),
		   geo_country_code = COALESCE(?, geo_country_code),
		   geo_status = ?,
		   geo_matched_uuid = ?
		 WHERE uuid = ?`,
		fields.GeoAddress,
		fields.GeoCity,
		fields.GeoRegion,
		fields.GeoCountry,
		fields.GeoCountryCode,
		fields.GeoStatus,
		fields.GeoMatchedUUID,
		uuid,
	)
	return err
}

// UpdateGeoStatus updates only the geo_status field for a given uuid.
func (g *GeoDB) UpdateGeoStatus(uuid, status string) error {
	_, err := g.db.Exec(
		`UPDATE metadata SET geo_status = ? WHERE uuid = ?`,
		status, uuid,
	)
	return err
}
