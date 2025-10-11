import {Worker} from 'worker_threads'
import * as os from 'os';
import { fileURLToPath } from 'url';
import path from 'path';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/*
  Export a function that queues pending work.
 */

const queue = [];

const createAsyncMethod = (method) => (sql, ...parameters) => {
  return new Promise((resolve, reject) => {
    queue.push({
      resolve,
      reject,
      message: { sql, parameters, method },
    });
    drainQueue();
  });
};

export const asyncGet = createAsyncMethod('get');
export const asyncAll = createAsyncMethod('all');
export const asyncRun = createAsyncMethod('run');

let workers = [];


/*
Instruct workers to drain the queue.
*/

function drainQueue() {
  for (const worker of workers) {
    worker.takeWork();
  }
}

export function closePool() {
  for (const worker of workers) {
    worker.shutDown();
  }
  workers = [];
}

/*
  Spawn workers that try to drain the queue.
 */

// Limit to 7 workers max (+1 for the main thread)
new Array(Math.min(os.availableParallelism(), 8)-1).fill(null).forEach(function spawn() {
  const workerInstance = new Worker(path.join(__dirname, 'db-worker.mjs'));

  let job = null; // Current item from the queue
  let error = null; // Error that caused the worker to crash

  function takeWork() {
    if (!job && queue.length) {
      // If there's a job in the queue, send it to the worker
      job = queue.shift();
      workerInstance.postMessage(job.message);
    }
  }

  function shutDown() {
    workerInstance.postMessage({ action: 'close' });
  }

  workerInstance
    .on('online', () => {
      workers.push({ takeWork, shutDown });
      takeWork();
    })
    .on('message', (response) => {
      if (response.success) {
        job.resolve(response.result);
      } else {
        job.reject(new Error(response.error));
      }
      job = null;
      takeWork(); // Check if there's more work to do
    })
    .on('error', (err) => {
      logger.error(err);
      error = err;
    })
    .on('exit', (code) => {
      workers = workers.filter(w => w !== workerInstance);
      if (job) {
        job.reject(error || new Error('worker died'));
      }
      if (code !== 0) {
        logger.error(`worker exited with code ${code}`);
        spawn(); // Worker died, so spawn a new one
      }
    });
});
