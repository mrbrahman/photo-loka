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
  
  function my(){
    // nothing much to do here
  }

  // need to call this as: p.enqueue(()=>fun(arg))
  // otherwise, function will get executed immediately, and promise will get resolved!
  my.enqueue = function(promiseGenerator){
    queue.push(promiseGenerator); // assume it is a promise
    pendingCnt++;
    if(autoStart)
      dequeue();
    
    return my;
  }

  my.enqueueMany = function(promiseGenerators){
    let noOfEntries = promiseGenerators.length;
    queue.push(...promiseGenerators);
    // TODO: check/read-up performance of spread above vs. 
    //    Array.prototype.push.apply(queue, promiseGenerators);
    pendingCnt+=noOfEntries;
    if(autoStart)
      dequeue();

    return my;
  }

  // this one is not exposed
  let dequeue = function(){
    if (!paused && processingCnt<maxConcurrency && queue.length>0){
      if(processingCnt == 0){
        if(emitter){
          emitter.emit('start_batch');
        }
      }

      processingCnt++; pendingCnt--;
      let item = processInInsertOrder ? queue.shift() : queue.pop();
      if(emitter){
        emitter.emit('start', item.toString()) // TODO: can we emit anything better?
      }
        
      item()
        .then(returnValue=>{
          // console.log('in then '+returnValue);
          processingCnt--; completedCnt++;
          if(emitter){
            emitter.emit('end', item.toString(), returnValue) // TODO: can we log anything better?
          }
        })
        .catch(error=>{
          console.log('caught error in parallel-processes');
          processingCnt--; failedCnt++;
          if(emitter){
            emitter.emit('error', item.toString(), error); // TODO: can we log anything better?
          }
        })
        .finally(()=>{
          if(pendingCnt==0 && emitter){
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
      processingCnt, pendingCnt, completedCnt, failedCnt, paused, maxConcurrency
    }
  }

  return my;
}