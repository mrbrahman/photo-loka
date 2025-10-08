import { addJob, deleteJob } from '#infra/scheduler';
import { config } from '#config';
import { enqueueStaleFiles } from '#indexing/stale-file-indexer';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

export function startNightlyIndexing() {
  if (!config.enableNightlyIndexing) {
    logger.info('Nightly indexing is disabled');
    return;
  }
  
  addJob('nightly-indexing', '0 1 * * *', enqueueStaleFiles);
}

export function stopNightlyIndexing() {
  deleteJob('nightly-indexing');
}
