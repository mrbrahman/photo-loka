import { ParallelProcesses } from '#utils/parallel-processes';
import { performReverseGeoEncoding } from './geo-cache.mjs';

const processor = new ParallelProcesses();

export function enqueue(uuid, gps_lat, gps_lng) {
  processor.enqueue(performReverseGeoEncoding, [uuid, gps_lat, gps_lng]);
}

export function enqueueMany(entries) {
  const tasks = entries.map(({uuid, gps_lat, gps_lng}) => [performReverseGeoEncoding, [uuid, gps_lat, gps_lng]]);
  processor.enqueueMany(tasks);
}

export function status() {
  return processor.status();
}