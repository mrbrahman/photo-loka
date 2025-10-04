import { addJob, deleteJob } from '../infrastructure/scheduler.mjs';
import { config } from '../config.mjs';
import { enqueueStaleFiles } from '../core/indexing/stale-file-indexer.mjs';

export function startNightlyIndexing() {
  if (!config.enableNightlyIndexing) {
    console.log('Nightly indexing is disabled');
    return;
  }
  
  addJob('nightly-indexing', '0 1 * * *', enqueueStaleFiles);
}

export function stopNightlyIndexing() {
  deleteJob('nightly-indexing');
}
