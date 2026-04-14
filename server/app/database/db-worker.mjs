import {parentPort} from 'worker_threads';

import Database from 'better-sqlite3';

import {startupConfig} from '#startup-config';
const dbFile = startupConfig.dbFile;
// Each worker will open a separate `sqlite3` connection
const db = new Database(dbFile, {  }); // verbose: console.log
db.pragma("busy_timeout = 5000");

const preparedStatements = new Map();

parentPort.on('message', ({ sql, parameters, method, action }) => {
  if (action === 'close') {
    db.close();
    return;
  }
  
  try {
    let stmt = preparedStatements.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      preparedStatements.set(sql, stmt);
    }
    
    const result = parameters && parameters.length > 0 ? 
      stmt[method || 'all'](...parameters) :   // parameters are individual arguments
      stmt[method || 'all'](parameters || {}); // parameters are named parameters in an object
    parentPort.postMessage({ success: true, result });
  } catch (error) {
    parentPort.postMessage({ success: false, error: error.message });
  }
});
