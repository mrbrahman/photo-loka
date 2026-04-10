import {EventEmitter} from 'events';
import { ParallelProcesses } from '#utils/parallel-processes';
import {config, updateRuntimeConfig} from '#config';
import { createLogger } from '#utils/logger';
import { fmtTime } from '#utils/time-format';
import * as systemMonitor from '#infra/system-monitor';
import os from 'os';

const logger = createLogger(import.meta.url);

class EmitterClass extends EventEmitter {};
export const indexerEvents = new EmitterClass();

let indexerQueue = config.indexerMode === 'static'
  ? ParallelProcesses.simple({
      maxConcurrency: config.maxConcurrency || os.cpus().length-1,
      emitter: indexerEvents
    })
  : ParallelProcesses.dynamic({
      maxConcurrency: config.maxConcurrency || os.cpus().length-1,
      systemMonitor: systemMonitor,
      emitter: indexerEvents
    });

export const indexerErrors = [];

let indexerBatchStart;
let indexrBatchStarted = false;

indexerEvents.on('start_batch', ()=>{
  if(!indexrBatchStarted){
    indexrBatchStarted = true;
    indexerBatchStart = performance.now();
  }
});

indexerEvents.on('all_done', ()=>{
  indexrBatchStarted = false;
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
  indexerQueue.maxConcurrency = c;
  updateRuntimeConfig('maxConcurrency', c);
}

export const indexerStatus = ()=>indexerQueue.status();

export function addToIndexQueue(taskFn, args, priority='normal'){
  indexerQueue.enqueue(taskFn, args, priority)
}

export function bulkAddToIndexQueue(tasks){
  indexerQueue.enqueueMany(tasks);
}

export let ignoreWatcherList = {};