import {EventEmitter} from 'events';
import { ParallelProcesses as pp } from '#utils/parallel-processes';
import {config} from '#config';
import { createLogger } from '#utils/logger';
import { fmtTime } from '#utils/time-format';

const logger = createLogger(import.meta.url);

class EmitterClass extends EventEmitter {};
export const indexerEvents = new EmitterClass();

let indexerQueue = pp()
  .maxConcurrency(config.maxIndexerConcurrency)
  .emitter(indexerEvents)
;

export const indexerErrors = [];

let indexerBatchStart;

indexerEvents.on('start_batch', ()=>{
  indexerBatchStart = performance.now();
});

indexerEvents.on('all_done', ()=>{
  logger.info(`Finished Indexer batch in ${fmtTime(performance.now()-indexerBatchStart)}`)
});

indexerEvents.on('error', (item, error)=>{
  logger.error(`IndexerEvents got error: ${item} ${error}`);
  indexerErrors.push(error);
})

export function pauseIndexer(){
  indexerQueue.pause();
}

export function resumeIndexer(){
  indexerQueue.resume();
}

export function updateIndexerConcurrency(concurrency){
  let c = Number(concurrency)
  // update indexerQueue
  indexerQueue.maxConcurrency(c);

  // update config
  config.maxIndexerConcurrency=c;

  // TODO permananet storage?
}

export const indexerStatus = ()=>indexerQueue.status();

export function addToIndexQueue(taskFn, args){
  indexerQueue.enqueue(taskFn, args)
}

export function bulkAddToIndexQueue(tasks){
  indexerQueue.enqueueMany(tasks);
}

export let ignoreWatcherList = {};