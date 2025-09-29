import {exiftool} from 'exiftool-vendored';
import {stopAllWatchers} from './file-watcher.mjs';
import {db} from '../database/sqlite-database.mjs';
import {closePool} from '../database/db-pool.mjs';
import {saveRateLimitState} from '../core/geo/rate-limiter.mjs';
import {stopNightlyIndexing} from '../jobs/nightly-indexing-job.mjs';

export async function shutdownCleanup(){
  stopAllWatchers();
  stopNightlyIndexing();
  saveRateLimitState();  // save rate limiting counters
  exiftool.end();
  closePool();
  db.close();
}