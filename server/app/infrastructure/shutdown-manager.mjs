import {exiftool} from 'exiftool-vendored';
import {stopAllWatchers} from '#jobs/file-watcher-job';
import {db} from '#db/sqlite-database';
import {closePool} from '#db/db-pool';
import {saveRateLimitState} from '#geo/rate-limiter';
import {stopAllScheduledIndexing} from '#jobs/scheduled-indexing-job';
import * as systemMonitor from '#infra/system-monitor';

export async function shutdownCleanup(){
  stopAllWatchers();
  stopAllScheduledIndexing();
  systemMonitor.stop();
  saveRateLimitState();  // save rate limiting counters
  exiftool.end();
  closePool();
  db.close();
}