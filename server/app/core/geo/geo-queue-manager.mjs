import { ParallelProcesses } from '#utils/parallel-processes';
import { finalizeGeo } from './geo-finalizer.mjs';
import { checkGeonamesRateLimit } from './rate-limiter.mjs';

const processor = new ParallelProcesses();

processor.pauseConditionFn = checkGeonamesRateLimit;

// Enqueue a single item for geo finalization.
// uuid is required; opts is { gps_lat, gps_lng, country_code } (all optional).
export function enqueue(uuid, opts) {
  processor.enqueue(finalizeGeo, [uuid, opts]);
}

// Enqueue many items for geo finalization.
// entries: array of { uuid, gps_lat, gps_lng, country_code }
export function enqueueMany(entries) {
  const tasks = entries.map(({ uuid, ...opts }) => [finalizeGeo, [uuid, opts]]);
  processor.enqueueMany(tasks);
}

export function status() {
  return processor.status();
}
