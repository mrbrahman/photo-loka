import { addJob, deleteJob } from '#infra/scheduler';
import { cleanupExpiredTokens } from '#infra/authn/authn-service';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

const JOB_NAME = 'token-cleanup';

export function scheduleTokenCleanup() {
  addJob(JOB_NAME, '0 3 * * *', cleanupExpiredTokens);
  logger.info('Token cleanup job scheduled');
}

export function stopTokenCleanup() {
  deleteJob(JOB_NAME);
}
