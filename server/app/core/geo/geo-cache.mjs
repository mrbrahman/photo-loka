import { ParallelProcesses } from '#utils/parallel-processes';
import { findExactGeoMatch, findProximityGeoMatch, updateGeoAddress, updateGeonamesData, updateGeoEncodingStatus } from './geo-encoding-db.mjs';
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
    logger.info(`Found exact match for ${uuid}`);
    // Parse geonames JSON and extract address
    const geonamesData = JSON.parse(exactMatch.geonames_json);
    const geo_address = [
      geonamesData.address.streetNumber,
      geonamesData.address.street,
      geonamesData.address.placename,
      geonamesData.address.adminName2,
      geonamesData.address.adminName1,
      geonamesData.address.countryCode
    ].filter(x => x).join(", ");
    
    // Update geo_address for the current uuid
    await updateGeoAddress(uuid, geo_address, 'FOUND_DB_EXACT_MATCH', exactMatch.uuid);
    return { uuid: exactMatch.uuid, geo_address };
  }

  // If no exact match, try proximity match (within reasonable distance)
  const proximityMatch = await findProximityGeoMatch(gps_lat, gps_lng);

  if (proximityMatch) {
    logger.info(`Found proximity match for ${uuid}`);
    // Parse geonames JSON and extract address
    const geonamesData = JSON.parse(proximityMatch.geonames_json);
    const geo_address = [
      geonamesData.address.streetNumber,
      geonamesData.address.street,
      geonamesData.address.placename,
      geonamesData.address.adminName2,
      geonamesData.address.adminName1,
      geonamesData.address.countryCode
    ].filter(x => x).join(", ");
    
    // Update geo_address for the current uuid
    await updateGeoAddress(uuid, geo_address, 'FOUND_DB_PROXIMITY_MATCH', proximityMatch.uuid);
    return { uuid: proximityMatch.uuid, geo_address };
  }

  // No match found, queue geonames lookup
  logger.info(`No DB match for ${uuid}, queuing API lookup`);
  await updateGeoEncodingStatus(uuid, 'QUEUED_FOR_API');
  geonamesProcessor.enqueue(lookupGeonames, [uuid, gps_lat, gps_lng]);
  return null;
}

async function lookupGeonames(uuid, gps_lat, gps_lng) {
  const url = `http://api.geonames.org/findNearestAddressJSON?lat=${gps_lat}&lng=${gps_lng}&username=${startupConfig.geonamesUsername}`;
  logger.info(`API lookup for ${uuid}: ${url}`);
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.address) {
      const geo_address = [
        data.address.streetNumber,
        data.address.street,
        data.address.placename,
        data.address.adminName2,
        data.address.adminName1,
        data.address.countryCode
      ].filter(x => x).join(", ");
      
      logger.info(`API success for ${uuid}: ${geo_address}`);
      
      // Increment counters after successful API call
      incrementCounters();
      
      // Update both geonames_json and geo_address
      await updateGeonamesData(uuid, JSON.stringify(data), geo_address);
      
      return { uuid, geo_address, geonames_data: data };
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
    logger.error('Geonames API error:', error);
    await updateGeoEncodingStatus(uuid, 'API_ERROR');
  }
  
  return null;
}