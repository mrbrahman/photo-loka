import * as db from './geo-encoding-db.mjs';
import { incrementCounters } from './rate-limiter.mjs';
import { createLogger } from '#utils/logger';
import { startupConfig } from '#startup-config';

const logger = createLogger(import.meta.url);

// ---------------------------------------------------------------------------
// finalizeGeo: single entry point for resolving geo_ fields on a metadata row.
//
// uuid is required. Optional fields (gps_lat, gps_lng, country_code) are used
// when available (e.g. from indexer). When not provided, they are derived from
// metadata + geo_lookups.
//
// Logic:
//   - No GPS -> nothing to do
//   - Non-US -> populate from exiftool geolocation in geo_lookups
//   - US -> cache check -> geonames API -> postal code if needed -> update
// ---------------------------------------------------------------------------
export async function finalizeGeo(uuid, { gps_lat, gps_lng, country_code } = {}) {
  // Derive missing fields from DB if not provided
  if (!gps_lat || !gps_lng || !country_code) {
    const ctx = await db.getGeoContext(uuid);
    if (!ctx) {
      logger.warn(`No metadata row found for ${uuid}, skipping geo finalization`);
      return;
    }
    gps_lat = gps_lat || ctx.gps_lat;
    gps_lng = gps_lng || ctx.gps_lng;
    country_code = country_code || ctx.country_code;
  }

  // No GPS = nothing to do
  if (!gps_lat || !gps_lng) {
    logger.info(`No GPS coordinates for ${uuid}, skipping geo finalization`);
    return;
  }

  if (country_code === 'US') {
    await finalizeUS(uuid, gps_lat, gps_lng);
  } else {
    await finalizeNonUS(uuid);
  }
}

// ---------------------------------------------------------------------------
// Non-US: populate geo_ fields from exiftool geolocation data in geo_lookups
// ---------------------------------------------------------------------------
async function finalizeNonUS(uuid) {
  const lookup = await db.getExiftoolGeoLookup(uuid);
  if (!lookup) {
    logger.info(`No exiftool geolocation data for ${uuid}`);
    return;
  }

  const geo = JSON.parse(lookup.response_json);

  const geo_address = [
    geo.GeolocationCity,
    geo.GeolocationSubregion,
    geo.GeolocationRegion,
    geo.GeolocationCountryCode,
    geo.GeolocationCountry
  ].filter(x => x).join(', ') || null;

  await db.updateGeoFields(uuid, {
    geo_address,
    geo_city: geo.GeolocationCity || null,
    geo_region: geo.GeolocationRegion || null,
    geo_country: geo.GeolocationCountry || null,
    geo_country_code: geo.GeolocationCountryCode || null,
    geo_status: 'RESOLVED_FROM_EXIFTOOL',
    geo_matched_uuid: null
  });

  logger.info(`Finalized geo for non-US ${uuid}: ${geo_address}`);
}

// ---------------------------------------------------------------------------
// US: check cache, call geonames API if needed, resolve city via postal code
// ---------------------------------------------------------------------------
async function finalizeUS(uuid, gps_lat, gps_lng) {
  logger.info(`Finalizing geo for US ${uuid} at ${gps_lat}, ${gps_lng}`);

  // Try exact match
  const exactMatch = await db.findExactGeoMatch(gps_lat, gps_lng);
  if (exactMatch) {
    logger.info(`Found exact match for ${uuid} via ${exactMatch.uuid}`);
    await db.updateGeoFields(uuid, {
      geo_address: exactMatch.geo_address,
      geo_city: exactMatch.geo_city,
      geo_region: exactMatch.geo_region,
      geo_country: exactMatch.geo_country,
      geo_country_code: exactMatch.geo_country_code,
      geo_status: 'FOUND_DB_EXACT_MATCH',
      geo_matched_uuid: exactMatch.uuid
    });
    return;
  }

  // Try proximity match
  const proximityMatch = await db.findProximityGeoMatch(gps_lat, gps_lng);
  if (proximityMatch) {
    logger.info(`Found proximity match for ${uuid} via ${proximityMatch.uuid}`);
    await db.updateGeoFields(uuid, {
      geo_address: proximityMatch.geo_address,
      geo_city: proximityMatch.geo_city,
      geo_region: proximityMatch.geo_region,
      geo_country: proximityMatch.geo_country,
      geo_country_code: proximityMatch.geo_country_code,
      geo_status: 'FOUND_DB_PROXIMITY_MATCH',
      geo_matched_uuid: proximityMatch.uuid
    });
    return;
  }

  // No cache hit -- call geonames API
  await db.updateGeoEncodingStatus(uuid, 'QUEUED_FOR_API');
  await lookupGeonames(uuid, gps_lat, gps_lng);
}

// ---------------------------------------------------------------------------
// Geonames findNearestAddress API call
// ---------------------------------------------------------------------------
async function lookupGeonames(uuid, gps_lat, gps_lng) {
  const url = `http://api.geonames.org/findNearestAddressJSON?lat=${gps_lat}&lng=${gps_lng}&username=${startupConfig.geonamesUsername}`;
  logger.info(`API lookup for ${uuid}: ${url}`);

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.address) {
      logger.info(`API success for ${uuid}: ${data.address.placename || '(no placename)'}, ${data.address.adminName1}`);

      incrementCounters();

      // Store in geo_lookups
      const requestParams = JSON.stringify({ lat: gps_lat, lng: gps_lng });
      await db.insertGeoLookup(uuid, 'geonames', 'findNearestAddress', requestParams, JSON.stringify(data));

      // Resolve geo fields from the address response
      await resolveFromAddress(uuid, data, 'FOUND_VIA_API', null);

    } else if (Object.keys(data).length > 0) {
      logger.error(`API error for ${uuid}: ${JSON.stringify(data)}`);
      await db.updateGeoEncodingStatus(uuid, 'API_ERROR');
      throw new Error(`Geonames API error response: ${JSON.stringify(data)}`);
    } else {
      logger.warn(`No address found for ${uuid}`);
      await db.updateGeoEncodingStatus(uuid, 'NO_ADDRESS_FOUND');
    }
  } catch (error) {
    if (error.message?.startsWith('Geonames API error response')) throw error;
    logger.error('Geonames API error:', error);
    await db.updateGeoEncodingStatus(uuid, 'API_ERROR');
  }
}

// ---------------------------------------------------------------------------
// Derive geo_ fields from a findNearestAddress response. Calls postal code
// lookup if placename is empty.
// ---------------------------------------------------------------------------
async function resolveFromAddress(uuid, findNearestAddressData, status, matchedUuid) {
  const addr = findNearestAddressData.address;

  let city = addr.placename || null;

  // If placename is empty and we have a postal code, do a postal code lookup
  if (!city && addr.postalcode && addr.countryCode) {
    city = await resolveCity(uuid, addr.postalcode, addr.countryCode);
  }

  // geonames findNearestAddress does not return full country name;
  // get it from exiftool geolocation data instead
  let geo_country = null;
  const exiftoolLookup = await db.getExiftoolGeoLookup(uuid);
  if (exiftoolLookup) {
    const exGeo = JSON.parse(exiftoolLookup.response_json);
    geo_country = exGeo.GeolocationCountry || null;
  }

  const geo_address = [
    addr.streetNumber,
    addr.street,
    city || addr.adminName2,  // fall back to county if no city resolved
    addr.adminName1,
    addr.countryCode
  ].filter(x => x).join(', ');

  await db.updateGeoFields(uuid, {
    geo_address,
    geo_city: city,
    geo_region: addr.adminName1 || null,
    geo_country,
    geo_country_code: addr.countryCode || null,
    geo_status: status,
    geo_matched_uuid: matchedUuid
  });
}

// ---------------------------------------------------------------------------
// Postal code lookup: resolve city/placeName when findNearestAddress gives
// an empty placename. Checks cache first, then calls geonames API.
// ---------------------------------------------------------------------------
async function resolveCity(uuid, postalcode, country) {
  // Check cache
  const cached = await db.findPostalCodeMatch(postalcode, country);
  if (cached) {
    const data = JSON.parse(cached.response_json);
    if (data.postalcodes && data.postalcodes.length > 0) {
      logger.info(`Postal code cache hit for ${postalcode}/${country}: ${data.postalcodes[0].placeName}`);
      return data.postalcodes[0].placeName || null;
    }
    return null;
  }

  // Cache miss - call API (counts against same rate limits)
  const url = `http://api.geonames.org/postalCodeLookupJSON?postalcode=${postalcode}&country=${country}&username=${startupConfig.geonamesUsername}`;
  logger.info(`Postal code lookup for ${uuid}: ${url}`);

  try {
    const response = await fetch(url);
    const data = await response.json();

    incrementCounters();

    // Store in geo_lookups
    const requestParams = JSON.stringify({ postalcode, country });
    await db.insertGeoLookup(uuid, 'geonames', 'postalCodeLookup', requestParams, JSON.stringify(data));

    if (data.postalcodes && data.postalcodes.length > 0) {
      logger.info(`Postal code lookup success: ${data.postalcodes[0].placeName}`);
      return data.postalcodes[0].placeName || null;
    }

    logger.warn(`Postal code lookup returned no results for ${postalcode}/${country}`);
    return null;
  } catch (error) {
    logger.error(`Postal code lookup error for ${postalcode}/${country}:`, error);
    return null;
  }
}
