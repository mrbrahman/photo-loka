import { addJob, deleteJob } from '#infra/scheduler';
import { config } from '#config';
import { enqueueStaleFiles } from '#indexing/stale-file-indexer';

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
