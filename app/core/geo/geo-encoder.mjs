import { ParallelProcesses } from '#utils/parallel-processes';
import { performReverseGeoEncoding } from './geo-cache.mjs';

const processor = ParallelProcesses();

export function enqueue(uuid, gps_lat, gps_long) {
  processor.enqueue(performReverseGeoEncoding, [uuid, gps_lat, gps_long]);
}

export function enqueueMany(entries) {
  const tasks = entries.map(({uuid, gps_lat, gps_long}) => [performReverseGeoEncoding, [uuid, gps_lat, gps_long]]);
  processor.enqueueMany(tasks);
}

export function status() {
  return processor.status();
}