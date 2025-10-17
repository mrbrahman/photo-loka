import {exiftool} from 'exiftool-vendored';
import {stopAllWatchers} from '#jobs/file-watcher-job';
import {db} from '#db/sqlite-database';
import {closePool} from '#db/db-pool';
import {saveRateLimitState} from '#geo/rate-limiter';
import {stopScheduledIndexing} from '#jobs/scheduled-indexing-job';

export async function shutdownCleanup(){
  stopAllWatchers();
  stopScheduledIndexing();
  saveRateLimitState();  // save rate limiting counters
  exiftool.end();
  closePool();
  db.close();
}