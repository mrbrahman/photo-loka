import { ParallelProcesses } from '#utils/parallel-processes';
import {
  findExactGeoMatch,
  findProximityGeoMatch,
  findPostalCodeMatch,
  insertGeoLookup,
  updateGeoFields,
  updateGeoEncodingStatus
} from './geo-encoding-db.mjs';
import { checkGeonamesRateLimit, incrementCounters } from './rate-limiter.mjs';
import { createLogger } from '#utils/logger';
import { startupConfig } from '#startup-config';

const logger = createLogger(import.meta.url);

const geonamesProcessor = ParallelProcesses.simple();

geonamesProcessor.pauseConditionFn = checkGeonamesRateLimit;

export async function performReverseGeoEncoding(uuid, gps_lat, gps_lng) {
  logger.info(`Starting reverse geo-encoding for ${uuid} at ${gps_lat}, ${gps_lng}`);

  // First try exact match up to 4 decimal places
  const exactMatch = await findExactGeoMatch(gps_lat, gps_lng);

  if (exactMatch) {
    logger.info(`Found exact match for ${uuid} via ${exactMatch.uuid}`);
    await updateGeoFields(uuid, {
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

  // If no exact match, try proximity match (within ~10m)
  const proximityMatch = await findProximityGeoMatch(gps_lat, gps_lng);

  if (proximityMatch) {
    logger.info(`Found proximity match for ${uuid} via ${proximityMatch.uuid}`);
    await updateGeoFields(uuid, {
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

  // No match found, queue geonames lookup
  logger.info(`No DB match for ${uuid}, queuing API lookup`);
  await updateGeoEncodingStatus(uuid, 'QUEUED_FOR_API');
  geonamesProcessor.enqueue(lookupGeonames, [uuid, gps_lat, gps_lng]);
}

async function lookupGeonames(uuid, gps_lat, gps_lng) {
  const url = `http://api.geonames.org/findNearestAddressJSON?lat=${gps_lat}&lng=${gps_lng}&username=${startupConfig.geonamesUsername}`;
  logger.info(`API lookup for ${uuid}: ${url}`);

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.address) {
      logger.info(`API success for ${uuid}: ${data.address.placename || '(no placename)'}, ${data.address.adminName1}`);

      // Increment counters after successful API call
      incrementCounters();

      // Store in geo_lookups
      const requestParams = JSON.stringify({ lat: gps_lat, lng: gps_lng });
      await insertGeoLookup(uuid, 'geonames', 'findNearestAddress', requestParams, JSON.stringify(data));

      // Resolve all geo fields (may trigger postal code lookup if placename is empty)
      await resolveGeoFields(uuid, data, 'FOUND_VIA_API', null);

    } else if (Object.keys(data).length > 0) {
      // Non-empty response without address indicates an error
      logger.error(`API error for ${uuid}: ${JSON.stringify(data)}`);
      await updateGeoEncodingStatus(uuid, 'API_ERROR');
      throw new Error(`Geonames API error response: ${JSON.stringify(data)}`);
    } else {
      // Empty response - no address found
      logger.warn(`No address found for ${uuid}`);
      await updateGeoEncodingStatus(uuid, 'NO_ADDRESS_FOUND');
    }
  } catch (error) {
    if (error.message?.startsWith('Geonames API error response')) throw error;
    logger.error('Geonames API error:', error);
    await updateGeoEncodingStatus(uuid, 'API_ERROR');
  }
}

// ---------------------------------------------------------------------------
// Resolve geo fields: after findNearestAddress data is available, determine
// city (possibly via postalCodeLookup) and write all fields to metadata.
// ---------------------------------------------------------------------------
async function resolveGeoFields(uuid, findNearestAddressData, status, matchedUuid) {
  const addr = findNearestAddressData.address;

  let city = addr.placename || null;

  // If placename is empty and we have a postal code, do a postal code lookup
  if (!city && addr.postalcode && addr.countryCode) {
    city = await resolveCity(uuid, addr.postalcode, addr.countryCode);
  }

  const geo_address = [
    addr.streetNumber,
    addr.street,
    city || addr.adminName2,  // fall back to county if no city resolved
    addr.adminName1,
    addr.countryCode
  ].filter(x => x).join(', ');

  await updateGeoFields(uuid, {
    geo_address,
    geo_city: city,
    geo_region: addr.adminName1 || null,
    geo_country: null,          // geonames findNearestAddress does not return full country name
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
  const cached = await findPostalCodeMatch(postalcode, country);
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
    await insertGeoLookup(uuid, 'geonames', 'postalCodeLookup', requestParams, JSON.stringify(data));

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
