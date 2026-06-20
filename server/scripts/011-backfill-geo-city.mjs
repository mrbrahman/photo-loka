// One-time script: backfill geo_city for US items that have a findNearestAddress
// response but an empty placename. Uses the postalCodeLookup API (with caching).
//
// Usage: node --env-file=.env scripts/backfill-geo-city.mjs [--dry-run]

import { db } from '#db/sqlite-database';
import { findPostalCodeMatch, insertGeoLookup, updateGeoFields } from '#geo/geo-encoding-db';
import { checkGeonamesRateLimit, incrementCounters } from '#geo/rate-limiter';
import { startupConfig } from '#startup-config';

const dryRun = process.argv.includes('--dry-run');

// Find US items where geo_city is null. Use geonames_json from either the
// item itself or the row it matched against (geo_matched_uuid).
const rows = db.prepare(`
  SELECT m.uuid, m.geo_status, m.geo_region, m.geo_country, m.geo_country_code,
    COALESCE(m.geonames_json, matched.geonames_json) AS response_json
  FROM metadata m
  LEFT JOIN metadata matched ON matched.uuid = m.geo_matched_uuid
  WHERE m.geo_city IS NULL
    AND m.geo_country_code = 'US'
    AND m.geo_address IS NOT NULL
    AND COALESCE(m.geonames_json, matched.geonames_json) IS NOT NULL
`).all();

console.log(`Found ${rows.length} US items with missing geo_city`);

if (dryRun) {
  for (const row of rows.slice(0, 10)) {
    const data = JSON.parse(row.response_json);
    console.log(`  ${row.uuid}: postalcode=${data.address?.postalcode}, placename="${data.address?.placename}"`);
  }
  console.log('Dry run - no changes made');
  process.exit(0);
}

let updated = 0;
let skipped = 0;
let errors = 0;

for (const row of rows) {
  const data = JSON.parse(row.response_json);
  const addr = data.address;

  if (!addr || !addr.postalcode || !addr.countryCode) {
    console.log(`  Skipping ${row.uuid}: no postalcode in response`);
    skipped++;
    continue;
  }

  let city = null;

  // Check cache first
  const cached = await findPostalCodeMatch(addr.postalcode, addr.countryCode);
  if (cached) {
    const cachedData = JSON.parse(cached.response_json);
    if (cachedData.postalcodes && cachedData.postalcodes.length > 0) {
      city = cachedData.postalcodes[0].placeName || null;
    }
    console.log(`  Cache hit for ${addr.postalcode}/${addr.countryCode}: ${city}`);
  } else {
    // Rate limit check
    if (!checkGeonamesRateLimit()) {
      console.log(`  Rate limit reached at item ${updated + skipped + errors}. Re-run later to continue.`);
      break;
    }

    // Call API
    const url = `http://api.geonames.org/postalCodeLookupJSON?postalcode=${addr.postalcode}&country=${addr.countryCode}&username=${startupConfig.geonamesUsername}`;
    try {
      const response = await fetch(url);
      const apiData = await response.json();

      incrementCounters();

      // Store in geo_lookups
      const requestParams = JSON.stringify({ postalcode: addr.postalcode, country: addr.countryCode });
      await insertGeoLookup(row.uuid, 'geonames', 'postalCodeLookup', requestParams, JSON.stringify(apiData));

      if (apiData.postalcodes && apiData.postalcodes.length > 0) {
        city = apiData.postalcodes[0].placeName || null;
      }
      console.log(`  API call for ${addr.postalcode}/${addr.countryCode}: ${city}`);
    } catch (error) {
      console.error(`  Error for ${row.uuid} (${addr.postalcode}/${addr.countryCode}):`, error.message);
      errors++;
      continue;
    }
  }

  if (city) {
    // Rebuild geo_address with city instead of adminName2
    const geo_address = [
      addr.streetNumber,
      addr.street,
      city,
      addr.adminName1,
      addr.countryCode
    ].filter(x => x).join(', ');

    await updateGeoFields(row.uuid, {
      geo_address,
      geo_city: city,
      geo_region: addr.adminName1 || row.geo_region,
      geo_country: row.geo_country,
      geo_country_code: addr.countryCode || row.geo_country_code,
      geo_status: row.geo_status || 'FOUND_VIA_API',
      geo_matched_uuid: null
    });
    updated++;
  } else {
    skipped++;
  }
}

console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
process.exit(0);
