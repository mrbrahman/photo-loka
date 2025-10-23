/*
  ParallelProcesses Class

  Run processes (functions) in parallel using controlled concurrency,
  with the ability the change concurrency even as the processes are running!

  Note: Promises are used to enable concurrent runs. However, at the end of
  promise completion, a promise is NOT returned (unlike the conventional way).

  Ideas borrowed from: https://medium.com/@karenmarkosyan/how-to-manage-promises-into-dynamic-queue-with-vanilla-javascript-9d0d1f8d4df5
 
*/

import os from 'os';
import { EventEmitter } from 'events';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

export class ParallelProcesses {
  #maxConcurrency = 1;
  #currentConcurrency = 1;
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
  #systemMonitor = null;
  #lastConcurrencyCheck = 0;
  #concurrencyCheckInterval = 3000;

  constructor(options = {}, isDynamic = false) {
    this.#maxConcurrency = options.maxConcurrency || 1;
    this.#processInInsertOrder = options.processInInsertOrder || false;
    this.#autoStart = options.autoStart !== false;
    this.#concurrencyCheckInterval = options.concurrencyCheckInterval || 3000;
    
    if (options.emitter) this.#emitter = options.emitter;
    if (options.pauseConditionFn) this.#pauseConditionFn = options.pauseConditionFn;
    
    // Dynamic concurrency mode
    if (isDynamic) {
      if (!options.systemMonitor) {
        throw new Error('systemMonitor is required for dynamic concurrency mode');
      }
      this.#systemMonitor = options.systemMonitor;
      this.#currentConcurrency = 1; // Always start at 1 for dynamic mode
      
      this.#systemMonitor.on('load-update', ({ recommendation }) => {
        this.#handleLoadRecommendation(recommendation);
      });
    }
  }


  // Static factory methods
  static simple(options = {}) {
    return new ParallelProcesses(options, false);
  }

  static dynamic(options = {}) {
    // If maxConcurrency not specified, use system limitations
    if (!options.maxConcurrency) {
      options.maxConcurrency = os.cpus().length * 2;
    }
    return new ParallelProcesses(options, true);
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
    const concurrencyLimit = this.#systemMonitor ? this.#currentConcurrency : this.#maxConcurrency;
    if (!this.#paused && this.#processingCnt < concurrencyLimit && this.#queue.length > 0) {
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
          setImmediate(() => this.#dequeue());
        });
    }
  }

  start() {
    const concurrencyLimit = this.#systemMonitor ? this.#currentConcurrency : this.#maxConcurrency;
    for (let i = 1; i <= concurrencyLimit; i++) {
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
      const oldConcurrency = this.#maxConcurrency;
      this.#maxConcurrency = value;
      
      // In static mode, trigger dequeue if concurrency increased
      if (!this.#systemMonitor && value > oldConcurrency) {
        for (let i = 1; i <= (value - oldConcurrency); i++) {
          this.#dequeue();
        }
      }
    }
  }

  get currentConcurrency() {
    return this.#currentConcurrency;
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

  #handleLoadRecommendation(recommendation) {
    const now = Date.now();
    logger.trace(`Received load recommendation: ${recommendation.action} (queue: ${this.#queue.length}, processing: ${this.#processingCnt}, current: ${this.#currentConcurrency})`);
    
    if (now - this.#lastConcurrencyCheck < this.#concurrencyCheckInterval) {
      logger.trace(`Skipping adjustment - too soon (${now - this.#lastConcurrencyCheck}ms < ${this.#concurrencyCheckInterval}ms)`);
      return;
    }
    
    const oldConcurrency = this.#currentConcurrency;
    
    switch (recommendation.action) {
      case 'REDUCE_AGGRESSIVE':
        this.#currentConcurrency = Math.max(1, Math.floor(this.#currentConcurrency * 0.5));
        logger.trace(`REDUCE_AGGRESSIVE: ${oldConcurrency} ??? ${this.#currentConcurrency}`);
        break;
      case 'REDUCE':
        this.#currentConcurrency = Math.max(1, this.#currentConcurrency - 1);
        logger.trace(`REDUCE: ${oldConcurrency} ??? ${this.#currentConcurrency}`);
        break;
      case 'INCREASE':
        if (this.#queue.length > 0) {
          this.#currentConcurrency = Math.min(this.#maxConcurrency, this.#currentConcurrency + 1);
          logger.trace(`INCREASE: ${oldConcurrency} ??? ${this.#currentConcurrency} (max: ${this.#maxConcurrency})`);
        } else {
          logger.trace(`INCREASE skipped - no pending tasks`);
        }
        break;
      case 'MAINTAIN':
        logger.trace(`MAINTAIN: keeping concurrency at ${this.#currentConcurrency}`);
        break;
    }
    
    if (oldConcurrency !== this.#currentConcurrency) {
      logger.trace(`Concurrency adjusted: ${oldConcurrency} ??? ${this.#currentConcurrency} (${recommendation.action})`);
      
      if (this.#currentConcurrency > oldConcurrency) {
        const additionalTasks = this.#currentConcurrency - oldConcurrency;
        logger.trace(`Starting ${additionalTasks} additional tasks`);
        for (let i = 1; i <= additionalTasks; i++) {
          this.#dequeue();
        }
      }
    }
    
    this.#lastConcurrencyCheck = now;
  }





  get systemMonitor() {
    return this.#systemMonitor !== null;
  }

  set systemMonitor(monitor) {
    if (this.#systemMonitor) {
      this.#systemMonitor.removeAllListeners('load-update');
    }
    
    this.#systemMonitor = monitor;
    
    if (monitor) {
      monitor.on('load-update', ({ recommendation }) => {
        this.#handleLoadRecommendation(recommendation);
      });
    }
    return this;
  }

  status() {
    const systemMetrics = this.#systemMonitor ? this.#systemMonitor.getMetrics() : null;
    
    return {
      processingCnt: this.#processingCnt,
      pendingCnt: this.#pendingCnt,
      completedCnt: this.#completedCnt,
      failedCnt: this.#failedCnt,
      paused: this.#paused,
      isDynamic: this.#systemMonitor !== null,
      maxConcurrency: this.#maxConcurrency,
      currentConcurrency: this.#currentConcurrency,
      systemMetrics
    };
  }
}
