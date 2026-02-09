/*
  Process Data in Chunks

  To aid in peformance of certain things, (e.g. insert data into SQLite) some operations
  are better when they are performed in bulk. This utlity enables exactly that.

  Setup the function for a specific usage by configuring "how much" to accumulate 
  (maxItemsBeforeScoop) before invoking the required function. Also, an idle time 
  can be specified (maxWaitTimeBeforeScoopMS) after which the function is invoked anyway. 
  Additionally, in case of emergencies (e.g. application shutting down)
  any unsaved work needs to be saved immediately, and the user can utlize runNow() for that purpose.

  An emitter can also be configured to listen to 'ran' events

  Note: Promises are used to enable concurrent runs. However, at the end of
  promise completion, a promise is NOT returned (unlike the conventional way).

*/

import {EventEmitter} from 'events';

export function ProcessDataInChunks(){
  var arr=[], maxItemsBeforeScoop=100, maxWaitTimeBeforeScoopMS=5000, timer, invokeFunction, emitter;
  
  function my(){
    // nothing much to do here
  }

  my.add = function(e){
    arr.push(e);
    resetTimer();
    process();
    return my;  // enable chaining
  }

  const resetTimer = function(){
    clearTimeout(timer)
    timer = setTimeout(doTask, maxWaitTimeBeforeScoopMS)
  }

  const doTask = function(){
    clearTimeout(timer);
    if(arr.length>0){
      let scoop = arr.splice(0, arr.length);
    
      invokeFunction(scoop)
        .then(returnValue=>{
          if(emitter){
            emitter.emit('ran', returnValue)
          }
        });
      ;
    } // if arr.length>0
  }

  let process = function(){
    if(arr.length >= maxItemsBeforeScoop){
      doTask()
    }
  }

  // provide an ability to run immediately, for e.g. cleanup during shutdown
  my.runNow = function(){
    doTask()
  }

  my.stats = function(){
    return arr.length;
  }

  my.maxItemsBeforeScoop = function(_){
    return arguments.length ? (maxItemsBeforeScoop = _, my): maxItemsBeforeScoop;
  }

  my.maxWaitTimeBeforeScoopMS = function(_){
    return arguments.length ? (maxWaitTimeBeforeScoopMS = _, my): maxWaitTimeBeforeScoopMS;
  }

  // use this with ()=>fn() syntax - so the function does not get
  // executed immediately!
  // also fn() needs to be an async function / return a promise
  my.invokeFunction = function(_){
    return arguments.length ? (invokeFunction = _, my): invokeFunction;
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

  return my;
}

