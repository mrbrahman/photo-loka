/*
  ParallelProcesses Class

  Run processes (functions) in parallel using controlled concurrency,
  with the ability the change concurrency even as the processes are running!

  Note: Promises are used to enable concurrent runs. However, at the end of
  promise completion, a promise is NOT returned (unlike the conventional way).

  Ideas borrowed from: https://medium.com/@karenmarkosyan/how-to-manage-promises-into-dynamic-queue-with-vanilla-javascript-9d0d1f8d4df5
 
*/

import { EventEmitter } from 'events';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

export class ParallelProcesses {
  #maxConcurrency = 1;
  #processInInsertOrder = false;
  #autoStart = true;
  #emitter = null;
  #pauseConditionFn = null;
  #queue = [];
  #processingCnt = 0;
  #pendingCnt = 0;
  #completedCnt = 0;
  #failedCnt = 0;
  #paused = false;

  constructor(options = {}) {
    this.#maxConcurrency = options.maxConcurrency || 1;
    this.#processInInsertOrder = options.processInInsertOrder || false;
    this.#autoStart = options.autoStart !== false;
    if (options.emitter) this.#emitter = options.emitter;
    if (options.pauseConditionFn) this.#pauseConditionFn = options.pauseConditionFn;
  }

  enqueue(func, args = []) {
    const task = {
      func,
      args,
      name: func.name || 'anonymous',
      execute: () => func.apply(null, args)
    };
    this.#queue.push(task);
    this.#pendingCnt++;
    if (this.#autoStart) this.#dequeue();
    return this;
  }

  enqueueMany(tasks) {
    const taskObjects = tasks.map(([func, args = []]) => ({
      func,
      args,
      name: func.name || 'anonymous',
      execute: () => func.apply(null, args)
    }));
    this.#queue.push(...taskObjects);
    this.#pendingCnt += taskObjects.length;
    if (this.#autoStart) this.#dequeue();
    return this;
  }

  #dequeue() {
    if (this.#pauseConditionFn && !this.#pauseConditionFn()) {
      this.#paused = true;
    }
    if (!this.#paused && this.#processingCnt < this.#maxConcurrency && this.#queue.length > 0) {
      if (this.#processingCnt === 0 && this.#emitter) {
        this.#emitter.emit('start_batch');
      }

      this.#processingCnt++;
      this.#pendingCnt--;
      const item = this.#processInInsertOrder ? this.#queue.shift() : this.#queue.pop();
      const taskInfo = `${item.name}(${item.args.map(arg => JSON.stringify(arg)).join(', ')})`;
      
      if (this.#emitter) {
        this.#emitter.emit('start', taskInfo);
      }

      item.execute()
        .then(returnValue => {
          this.#processingCnt--;
          this.#completedCnt++;
          if (this.#emitter) {
            this.#emitter.emit('end', taskInfo, returnValue);
          }
        })
        .catch(error => {
          logger.error(`Error while processing task ${taskInfo}: ${error}`);
          this.#processingCnt--;
          this.#failedCnt++;
          if (this.#emitter) {
            this.#emitter.emit('error', taskInfo, error);
          }
        })
        .finally(() => {
          if (this.#pendingCnt === 0 && this.#processingCnt === 0 && this.#emitter) {
            this.#emitter.emit('all_done');
          }
          this.#dequeue();
        });
    }
  }

  start() {
    for (let i = 1; i <= this.#maxConcurrency; i++) {
      this.#dequeue();
    }
    return this;
  }

  pause() {
    this.#paused = true;
    return this;
  }

  resume() {
    this.#paused = false;
    this.start();
    return this;
  }

  get maxConcurrency() {
    return this.#maxConcurrency;
  }

  set maxConcurrency(value) {
    if (value > 0) {
      const currentMax = this.#maxConcurrency;
      this.#maxConcurrency = value;
      if (value > currentMax) {
        for (let i = 1; i <= (value - currentMax); i++) {
          this.#dequeue();
        }
      }
    }
  }

  get processInInsertOrder() {
    return this.#processInInsertOrder;
  }

  set processInInsertOrder(value) {
    this.#processInInsertOrder = value;
    return this;
  }

  get autoStart() {
    return this.#autoStart;
  }

  set autoStart(value) {
    this.#autoStart = value;
    return this;
  }

  get emitter() {
    return this.#emitter ? true : false;
  }

  set emitter(value) {
    if (!(value instanceof EventEmitter)) {
      throw new Error('Emitter parameter is not an instance of EventEmitter class!');
    }
    this.#emitter = value;
    return this;
  }

  get pauseConditionFn() {
    return this.#pauseConditionFn;
  }

  set pauseConditionFn(value) {
    this.#pauseConditionFn = value;
    return this;
  }

  status() {
    return {
      processingCnt: this.#processingCnt,
      pendingCnt: this.#pendingCnt,
      completedCnt: this.#completedCnt,
      failedCnt: this.#failedCnt,
      paused: this.#paused,
      maxConcurrency: this.#maxConcurrency
    };
  }
}
