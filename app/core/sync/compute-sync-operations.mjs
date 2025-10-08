import * as path from 'path';

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

function getRelativePath(fullPath, collectionPaths) {
  for (let colPath of collectionPaths) {
    if (fullPath.startsWith(colPath)) {
      return fullPath.substring(colPath.length);
    }
  }
  return null;
}

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

export function computeSyncOperations(changes, listenPaths, collectionPaths, target) {
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
    console.log(`processing ${idx}: ${JSON.stringify(changes[idx])}`);
    if (change.skip) continue;

    if (change.action === 'create-dir') {
      // first get effective path (in case of further rename dirs)
      let currentPath = effectivePath(idx, change.path2);
      if (currentPath){
        effective.push({
          'action': 'create-dir', 
          path1: null, 
          path2: getTargetPath(currentPath, collectionPaths, target)
        });
      }
    }

    else if (change.action === 'in-place') {
      let currentPath = effectivePath(idx, change.path2);
      if (currentPath) {
        effective.push({
          'action': 'dir-and-copy', 
          path1: currentPath, 
          path2: getTargetPath(currentPath, collectionPaths, target)
        });
      }
    }
    
    else if (change.action === 'move') {
      if (isListenPath(change.path1, listenPaths)) {
        // file is moved from listen path to collection
        let currentPath = effectivePath(idx, change.path2);
        if (currentPath) {
          effective.push({
            'action': 'copy', 
            path1: currentPath, 
            path2: getTargetPath(currentPath, collectionPaths, target)
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
            path1: fromPath, 
            path2: toPath
          });
        }
      }
    }

    else if (change.action === 'delete') {
      effective.push({
        'action': 'delete', 
        path1: getTargetPath(change.path1, collectionPaths, target), 
        path2: null
      })
    }
  }
  return effective;
}

