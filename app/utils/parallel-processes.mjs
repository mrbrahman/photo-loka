/*
  ParallelProcesses

  Run processes (functions) in parallel using controlled concurrency,
  with the ability the change concurrency even as the processes are running!

  Note: Promises are used to enable concurrent runs. However, at the end of
  promise completion, a promise is NOT returned (unlike the conventional way).

  Ideas borrowed from: https://medium.com/@karenmarkosyan/how-to-manage-promises-into-dynamic-queue-with-vanilla-javascript-9d0d1f8d4df5
 
*/

// TODO: Should this return a promise?

import {EventEmitter} from 'events';

export function ParallelProcesses(){
  var maxConcurrency=1, processInInsertOrder=false, autoStart=true, emitter;
  let queue=[], processingCnt=0, pendingCnt=0, completedCnt=0, failedCnt=0, paused=false;
  let maxDailyExecutions=null, dailyExecutionCount=0, currentDate=null;
  
  function my(){
    // nothing much to do here
  }

  function getTodayString(){
    return new Date().toISOString().split('T')[0];
  }

  function checkDailyLimit(){
    const today = getTodayString();
    if(currentDate !== today){
      currentDate = today;
      dailyExecutionCount = 0;
    }
    return maxDailyExecutions === null || dailyExecutionCount < maxDailyExecutions;
  }

  // need to call this as: p.enqueue(fun, [arg1, arg2])
  my.enqueue = function(func, args = []){
    const task = {
      func,
      args,
      name: func.name || 'anonymous',
      execute: () => func.apply(null, args)
    };
    queue.push(task);
    pendingCnt++;
    if(autoStart)
      dequeue();
    
    return my;
  }

  my.enqueueMany = function(tasks){
    let noOfEntries = tasks.length;
    const taskObjects = tasks.map(([func, args = []]) => ({
      func,
      args,
      name: func.name || 'anonymous',
      execute: () => func.apply(null, args)
    }));
    queue.push(...taskObjects);
    pendingCnt+=noOfEntries;
    if(autoStart)
      dequeue();

    return my;
  }

  // this one is not exposed
  let dequeue = function(){
    if (!paused && processingCnt<maxConcurrency && queue.length>0 && checkDailyLimit()){
      if(processingCnt == 0){
        if(emitter){
          emitter.emit('start_batch');
        }
      }

      processingCnt++; pendingCnt--;
      let item = processInInsertOrder ? queue.shift() : queue.pop();
      const taskInfo = `${item.name}(${item.args.map(arg => JSON.stringify(arg)).join(', ')})`;
      if(emitter){
        emitter.emit('start', taskInfo)
      }
        
      item.execute()
        .then(returnValue=>{
          // console.log('in then '+returnValue);
          processingCnt--; completedCnt++;
          dailyExecutionCount++;
          if(emitter){
            emitter.emit('end', taskInfo, returnValue)
          }
        })
        .catch(error=>{
          console.error('caught error in parallel-processes:', error);
          processingCnt--; failedCnt++;
          if(emitter){
            emitter.emit('error', taskInfo, error);
          }
        })
        .finally(()=>{
          if(pendingCnt==0 && processingCnt==0 && emitter){
            emitter.emit('all_done')
          }
          dequeue()
        })
    }
  }

  my.start = function(){
    for(let i=1; i<=(maxConcurrency); i++){
      dequeue();
    }
  }

  my.pause = function(){
    paused = true;
  }

  my.resume = function(){
    paused = false;
    my.start()
  }

  my.maxConcurrency = function(_){
    if(arguments.length){
      let currentMaxConcurrency = maxConcurrency;
      if(_ > 0){
        maxConcurrency = _;
        if(maxConcurrency > currentMaxConcurrency){
          // initiate additional dequeue
          for(let i=1; i<=(maxConcurrency-currentMaxConcurrency); i++){
            dequeue();
          }
        }
      }

      return my;
      
    } else {
      return maxConcurrency;
    }
  }

  my.processInInsertOrder = function(_){
    return arguments.length ? (processInInsertOrder = _, my): processInInsertOrder;
  }

  my.autoStart = function(_){
    return arguments.length ? (autoStart = _, my): autoStart;
  }

  my.maxDailyExecutions = function(_){
    return arguments.length ? (maxDailyExecutions = _, my): maxDailyExecutions;
  }

  my.emitter = function(_){
    if(arguments.length){
      if(!_ instanceof EventEmitter){
        throw 'Emitter parameter is not an instance of EventEmitter class!'
      } else {
        emitter = _;
      }
      return my;
    } else {
      return emitter ? true : false;
    }
  }

  my.status = function(){
    return {
      processingCnt, pendingCnt, completedCnt, failedCnt, paused, maxConcurrency,
      dailyExecutionCount, maxDailyExecutions, currentDate
    }
  }

  return my;
}