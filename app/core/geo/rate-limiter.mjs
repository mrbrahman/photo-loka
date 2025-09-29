import { config } from '../../config.mjs';
import { saveRateLimitCounters, loadRateLimitCounters } from './geo-encoding-db.mjs';

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

export function checkGeonamesRateLimit() {
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
    }, resumeTime + 30000); // Add 30 seconds buffer for clock sync issues
    
    return false;
  }
  
  return true;
}

export function incrementCounters() {
  hourlyCount++;
  dailyCount++;
}

export function saveRateLimitState() {
  saveRateLimitCounters(hourlyCount, dailyCount, currentHour, currentDay);
}

export function getRateLimitStatus() {
  return {
    hourlyCount,
    dailyCount,
    hourlyLimit: config.geonamesHourlyLimit,
    dailyLimit: config.geonamesDailyLimit
  };
}