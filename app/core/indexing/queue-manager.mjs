import {EventEmitter} from 'events';
import { ParallelProcesses as pp } from '../../utils/parallel-processes.mjs';
import {config} from '../../config.mjs';

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
  console.log(`Finished Indexer batch in ${(performance.now()-indexerBatchStart)/1000/60} mins`)
});

indexerEvents.on('error', (item, error)=>{
  console.log(`IndexerEvents got error: ${item} ${error}`);
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