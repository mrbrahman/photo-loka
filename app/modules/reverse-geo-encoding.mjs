import { ParallelProcesses } from '../utils/parallel-processes.mjs';
import { findExactGeoMatch, findProximityGeoMatch, updateGeoAddress, updateGeonamesData, updateGeoEncodingStatus, saveRateLimitCounters, loadRateLimitCounters } from '../database/geo-encoding-db.mjs';
import { config } from '../config.mjs';
import 'dotenv/config';

const processor = ParallelProcesses();
const geonamesProcessor = ParallelProcesses();

// Rate limiting for geonames API
let hourlyCount = 0, dailyCount = 0;
let currentHour = new Date().getUTCHours();
let currentDay = new Date().getUTCDate();

// Load saved counters on startup
const savedCounters = loadRateLimitCounters();
if (savedCounters) {
  const now = new Date();
  const hour = now.getUTCHours();
  const day = now.getUTCDate();
  
  // Only restore if same hour/day
  if (savedCounters.current_hour === hour) hourlyCount = savedCounters.hourly_count;
  if (savedCounters.current_day === day) dailyCount = savedCounters.daily_count;
}

function checkGeonamesRateLimit() {
  const now = new Date();
  const hour = now.getUTCHours();
  const day = now.getUTCDate();
  
  // Reset hourly counter at hour mark
  if (hour !== currentHour) {
    hourlyCount = 0;
    currentHour = hour;
  }
  
  // Reset daily counter at midnight UTC
  if (day !== currentDay) {
    dailyCount = 0;
    currentDay = day;
  }
  
  // Check limits
  if (hourlyCount >= config.geonamesHourlyLimit || dailyCount >= config.geonamesDailyLimit) {
    // Set timeout to resume at next appropriate time
    const msToNextHour = (60 - now.getUTCMinutes()) * 60 * 1000 - now.getUTCSeconds() * 1000;
    const msToMidnight = (24 - now.getUTCHours()) * 60 * 60 * 1000 - now.getUTCMinutes() * 60 * 1000 - now.getUTCSeconds() * 1000;
    
    const resumeTime = hourlyCount >= config.geonamesHourlyLimit ? msToNextHour : msToMidnight;
    
    setTimeout(() => {
      if (hourlyCount >= config.geonamesHourlyLimit && hour !== new Date().getUTCHours()) hourlyCount = 0;
      if (dailyCount >= config.geonamesDailyLimit && day !== new Date().getUTCDate()) dailyCount = 0;
      geonamesProcessor.resume();
    }, resumeTime + 30000); // Add 30 seconds buffer for clock sync issues
    
    return false;
  }
  
  return true;
}

geonamesProcessor.pauseConditionFn(checkGeonamesRateLimit);

export function enqueue(uuid, gps_lat, gps_long) {
  processor.enqueue(performReverseGeoEncoding, [uuid, gps_lat, gps_long]);
}

export function enqueueMany(entries) {
  const tasks = entries.map(({uuid, gps_lat, gps_long}) => [performReverseGeoEncoding, [uuid, gps_lat, gps_long]]);
  processor.enqueueMany(tasks);
}

export function status() {
  return {
    dbLookup: processor.status(),
    geonamesApi: {
      ...geonamesProcessor.status(),
      hourlyCount,
      dailyCount,
      hourlyLimit: config.geonamesHourlyLimit,
      dailyLimit: config.geonamesDailyLimit
    }
  };
}

export function saveRateLimitState() {
  saveRateLimitCounters(hourlyCount, dailyCount, currentHour, currentDay);
}

async function performReverseGeoEncoding(uuid, gps_lat, gps_long) {
  console.log(`Starting reverse geo-encoding for ${uuid} at ${gps_lat}, ${gps_long}`);
  
  // First try exact match up to 4 decimal places
  const exactMatch = findExactGeoMatch(gps_lat, gps_long);

  if (exactMatch) {
    console.log(`Found exact match for ${uuid}`);
    // Parse geonames JSON and extract address
    const geonamesData = JSON.parse(exactMatch.geonames_rev_address_json);
    const geo_address = [
      geonamesData.address.streetNumber,
      geonamesData.address.street,
      geonamesData.address.placename,
      geonamesData.address.adminName2,
      geonamesData.address.adminName1,
      geonamesData.address.countryCode
    ].filter(x => x).join(", ");
    
    // Update geo_address for the current uuid
    updateGeoAddress(uuid, geo_address, 'FOUND_DB_EXACT_MATCH', exactMatch.uuid);
    return { uuid: exactMatch.uuid, geo_address };
  }

  // If no exact match, try proximity match (within reasonable distance)
  const proximityMatch = findProximityGeoMatch(gps_lat, gps_long);

  if (proximityMatch) {
    console.log(`Found proximity match for ${uuid}`);
    // Parse geonames JSON and extract address
    const geonamesData = JSON.parse(proximityMatch.geonames_rev_address_json);
    const geo_address = [
      geonamesData.address.streetNumber,
      geonamesData.address.street,
      geonamesData.address.placename,
      geonamesData.address.adminName2,
      geonamesData.address.adminName1,
      geonamesData.address.countryCode
    ].filter(x => x).join(", ");
    
    // Update geo_address for the current uuid
    updateGeoAddress(uuid, geo_address, 'FOUND_DB_PROXIMITY_MATCH', proximityMatch.uuid);
    return { uuid: proximityMatch.uuid, geo_address };
  }

  // No match found, queue geonames lookup
  console.log(`No DB match for ${uuid}, queuing API lookup`);
  updateGeoEncodingStatus(uuid, 'QUEUED_FOR_API');
  geonamesProcessor.enqueue(lookupGeonames, [uuid, gps_lat, gps_long]);
  return null;
}

async function lookupGeonames(uuid, gps_lat, gps_long) {
  const url = `http://api.geonames.org/findNearestAddressJSON?lat=${gps_lat}&lng=${gps_long}&username=${process.env.GEONAMES_USERNAME}`;
  console.log(`API lookup for ${uuid}: ${url}`);
  
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
      
      console.log(`API success for ${uuid}: ${geo_address}`);
      
      // Increment counters after successful API call
      hourlyCount++;
      dailyCount++;
      
      // Update both geonames_rev_address_json and geo_address
      updateGeonamesData(uuid, JSON.stringify(data), geo_address);
      
      return { uuid, geo_address, geonames_data: data };
    } else if (Object.keys(data).length > 0) {
      // Non-empty response without address indicates an error
      console.log(`API error for ${uuid}: ${JSON.stringify(data)}`);
      updateGeoEncodingStatus(uuid, 'API_ERROR');
      throw new Error(`Geonames API error response: ${JSON.stringify(data)}`);
    } else {
      // Empty response - no address found
      console.log(`No address found for ${uuid}`);
      updateGeoEncodingStatus(uuid, 'NO_ADDRESS_FOUND');
    }
  } catch (error) {
    console.error('Geonames API error:', error);
    updateGeoEncodingStatus(uuid, 'API_ERROR');
  }
  
  return null;
}

