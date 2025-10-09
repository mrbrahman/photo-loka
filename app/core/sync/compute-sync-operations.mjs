import * as path from 'path';
import * as fs from 'fs/promises';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

// Scenario 1: simple one
// let changes = [
//   {action: 'create-dir', path1: null, path2: '/path/to/collection/dir1'},
//   {action: 'move', path1: 'listen1/file11.jpg', path2: '/path/to/collection/dir1/file11.jpg'},
//   {action: 'move', path1: 'listen1/file12.jpg', path2: '/path/to/collection/dir1/file12.jpg'},
//   {action: 'move', path1: 'listen2/file13.jpg', path2: '/path/to/collection/dir1/file13.jpg'}
// ];

// Scenario 2: with rename of dir
// let changes = [
//   {action: 'create-dir', path1: null, path2: '/path/to/collection/dir1'},
//   {action: 'move', path1: 'listen1/file11.jpg', path2: '/path/to/collection/dir1/file11.jpg'},
//   {action: 'move', path1: 'listen1/file12.jpg', path2: '/path/to/collection/dir1/file12.jpg'},
//   {action: 'move', path1: 'listen2/file13.jpg', path2: '/path/to/collection/dir1/file13.jpg'},
  
//   {action: 'move', path1: '/path/to/collection/dir1', path2: '/path/to/collection/dir2'},
// ];

// Scenario 3: dir1 already created in backup
// let changes = [
//   {action: 'move', path1: 'listen1/file11.jpg', path2: '/path/to/collection/dir1/file11.jpg'},
//   {action: 'move', path1: 'listen1/file12.jpg', path2: '/path/to/collection/dir1/file12.jpg'},
//   {action: 'move', path1: 'listen2/file13.jpg', path2: '/path/to/collection/dir1/file13.jpg'},
  
//   {action: 'move', path1: '/path/to/collection/dir1', path2: '/path/to/collection/dir2'},
// ];

// Scenario 4: new dir, file moved from listen path, and then moved to another album, original dir deleted
// let changes = [
//   {action: 'create-dir', path1: null, path2: '/path/to/collection/dir1'},
//   {action: 'move', path1: 'listen1/file11.jpg', path2: '/path/to/collection/dir1/file11.jpg'},
//   {action: 'move', path1: '/path/to/collection/dir1/file11.jpg', path2: '/path/to/collection/dir2/file11.jpg'},
  
//   {action: 'delete', path1: '/path/to/collection/dir1', path2: null},
// ];

// let changes = [
//   {action: 'in-place', path1: null, path2: '/path/to/collection/dir1/file11.jpg'},
//   {action: 'move', path1: '/path/to/collection/dir1/file11.jpg', path2: '/path/to/collection/dir2/file11.jpg'},
  
//   {action: 'delete', path1: '/path/to/collection/dir1', path2: null},
// ];

function getTargetPath(srcPath, collectionPaths, target) {
  for (let colPath of collectionPaths) {
    if (srcPath.startsWith(colPath)) {
      return path.join(
        target, 
        srcPath.substring(colPath.length)
      );
    }
  }
  return null;
}

function isListenPath(fullPath, listenPaths) {
  for (let listenPath of listenPaths) {
    if (fullPath.startsWith(listenPath)) {
      return true;
    }
  }
  return false;
}

export async function computeSyncOperations(changes, listenPaths, collectionPaths, target) {
  let effective = [];
  let pathChanges = new Map();

  // Given a dir path, check if any of its parent dirs have been moved
  // If so, return the final effective dir
  function effectiveDir(dirPath){
    // recursively lookup path changes
    if (pathChanges.has(dirPath)) {
      return effectiveDir(pathChanges.get(dirPath));
    }
    return dirPath;
  }

  // Given an index and a path, check if there are further changes to this path
  // If so, return the final effective path (or null if deleted)
  // Mark all intermediate changes as 'skip', so they are not processed again

  function effectivePath(idx, idxPath) {
    for (let i=idx+1; i<changes.length; i++) {
      let ch = changes[i];
      if(ch.path1 === idxPath) {
        if (ch.action === 'delete') {
          // skip the current action, this is eventually deleted, and cannot be found
          ch.skip = true;
          return null;
        }
        else if (ch.action === 'move') {
          // note down the change
          pathChanges.set(idxPath, ch.path2);
          // skip the current action, this is eventually moved, and cannot be found
          ch.skip = true;
          
          // recursively check further changes
          return effectivePath(i, ch.path2);
        }
      }
    }
    // no further changes found, return current path, but apply effective dir changes on files
    return path.extname(idxPath) ? path.join(effectiveDir(path.dirname(idxPath)), path.basename(idxPath)) : idxPath;
  }

  for (let [idx, change] of changes.entries()) {
    // a quick revision of the file_audit_log entries:
    // (path1 is always the source path, path2 is always the destination path)

    // ┌────────────┬─────────────────────┬───────────────────────┬───────────────────────────────┐
    // │ action     │ path1               │ path2                 │ Description                   │
    // ├────────────┼─────────────────────┼───────────────────────┼───────────────────────────────┤
    // │ create-dir │ null                │ dir created           │ New directory created.        │
    // │ in-place   │ null                │ file indexed in place │ File indexed without moving.  │
    // │ move       │ old full path       │ new full path         │ File/dir moved or relocated.  │
    // │ delete     │ full path deleted   │ null                  │ File or directory deleted.    │
    // └────────────┴─────────────────────┴───────────────────────┴───────────────────────────────┘

    //  (note: move can be from listen path to collection, or within collection)

    logger.debug(`processing ${idx}: ${JSON.stringify(changes[idx])}`);
    if (change.skip) continue;

    if (change.action === 'create-dir') {
      // first get effective path (in case of further rename dirs)
      let currentPath = effectivePath(idx, change.path2);
      if (currentPath){
        let srcDirStats = await fs.stat(currentPath);

        effective.push({
          'action': 'create-dir', 
	  id: change.id,
          path1: null, 
          path2: getTargetPath(currentPath, collectionPaths, target),
          // we store the stats of the source dir, which will be used further to 'touch' the target dir
          stats: { atime: srcDirStats.atime, mtime: srcDirStats.mtime, mode: srcDirStats.mode }
        });
      }
    }

    else if (change.action === 'in-place') {
      let currentPath = effectivePath(idx, change.path2);
      if (currentPath) {
        // get the stats of the dir where the file was in-place indexed
        let srcDirStats = await fs.stat(path.dirname(currentPath));

        effective.push({
          'action': 'dir-and-copy', 
	  id: change.id,
          path1: currentPath, 
          path2: getTargetPath(currentPath, collectionPaths, target),
          // we store the stats of the source dir, which will be used further to 'touch' the target dir
          stats: { atime: srcDirStats.atime, mtime: srcDirStats.mtime, mode: srcDirStats.mode }
        });
      }
    }
    
    else if (change.action === 'move') {
      if (isListenPath(change.path1, listenPaths)) {
        // file is moved from listen path to collection
        let currentPath = effectivePath(idx, change.path2);
        
        if (currentPath) {
          let srcDirStats = await fs.stat(path.dirname(currentPath));
          
          effective.push({
            'action': 'copy', 
	    id: change.id,
            path1: currentPath, 
            path2: getTargetPath(currentPath, collectionPaths, target),
            // we store the stats of the source dir, which will be used further to 'touch' the target dir
            stats: { atime: srcDirStats.atime, mtime: srcDirStats.mtime, mode: srcDirStats.mode }
          });
        }
      }
      else {
        // file is moved within collection
        let fromPath = getTargetPath(change.path1, collectionPaths, target);
        let toPath = getTargetPath(effectivePath(idx, change.path2), collectionPaths, target);

        if(toPath){
          effective.push({
            'action': 'move', 
            id: change.id,
            path1: fromPath, 
            path2: toPath
            // move of a file/dir within a collection does not change the timestamps
          });
        }
      }
    }

    else if (change.action === 'delete') {
      effective.push({
        'action': 'delete', 
	id: change.id,
        path1: getTargetPath(change.path1, collectionPaths, target), 
        path2: null
        // TODO - need to distinguish between file and dir deletion, and handle sync time in case of deleteion of files
        // probably have separate actions: 'delete-file' and 'delete-dir'
        // for now not worrying about it, as I'm not doing deletions (purge from trash yet to be implemented)
      })
    }
  }

  // now figure out the directory 'touch' operations
  // i.e. sync up the modify and access times of directories
  // note - this is not needed for files, as when the files are copied, they are copied
  // with the correct times. However with directories, the time on the directory
  // changes each time an operation (create/move/delete) is carried out within the directory

  // this part is a little tricky to understand, need to pay attention to the fact that
  // stats always comes from the original source of the backup (collection dir/file)
  let allTargetDirs = new Map();
  for (let op of effective) {
    if (op.action === 'create-dir' ) {
      // create-dir is the target, but stats is from the source (see 'create-dir' handling above)
      allTargetDirs.set(op.path2, {stats: op.stats, id: op.id});
    }
    else if (op.action === 'dir-and-copy' || op.action === 'copy') {
      allTargetDirs.set(path.dirname(op.path2), {stats: op.stats, id: op.id});
    }
    else if (op.action === 'delete') {
      // TODO: handle dirs, when delete-file is implemented
    }
  }

  // add touch actions on target dirs
  allTargetDirs.forEach((v,k) => {
    effective.push({
      action: 'dir-touch',
      id: v.id,
      path1: k,
      stats: v.stats
    })
  });
  
  return effective;
}

