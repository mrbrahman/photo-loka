import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

export async function executeBackupOperations(operations) {
  const results = [];
  
  for (const op of operations) {
    try {
      const result = await executeSingleOperation(op);
      results.push({ ...op, success: true, result });
      logger.info(`Backup operation completed: ${op.action} - ${op.path1 || 'null'} -> ${op.path2 || 'null'}`);
    } catch (error) {
      results.push({ ...op, success: false, error: error.message });
      logger.error(`Backup operation failed: ${op.action} - ${error.message}`);
      break;
    }
  }
  
  return results;
}

async function executeSingleOperation(operation) {
  switch (operation.action) {
    case 'create-dir':
      return await createDirectory(operation.path2);
    
    case 'copy':
      return await copyFile(operation.path1, operation.path2);
    
    case 'dir-and-copy':
      return await dirAndCopy(operation.path1, operation.path2);
    
    case 'move':
      return await moveFile(operation.path1, operation.path2);
    
    case 'delete':
      return await deleteFileOrDir(operation.path1);
    
    case 'dir-touch':
      return await dirTouch(operation.path1, operation.stats);
    
    default:
      throw new Error(`Unknown backup operation: ${operation.action}`);
  }
}

async function createDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  return `Directory created: ${dirPath}`;
}

async function copyFile(srcPath, destPath) {
  // note: can't use the stats on the record, as that's the directory stats and not file stats
  let stats = await fs.stat(srcPath);
  
  await fs.cp(srcPath, destPath, {preserveTimestamps: true, errorOnExist: true});
  await fs.chmod(destPath, stats.mode);
  
  return `File copied: ${srcPath} -> ${destPath}`;
}

async function dirAndCopy(srcPath, destPath) {
  const destDir = path.dirname(destPath);
  try {
    await fs.access(destDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.mkdir(destDir, { recursive: true });
    } else {
      throw error;
    }
  }
  let result = await copyFile(srcPath, destPath);

  return `Directory created (if needed) and file copied: ${srcPath} -> ${destPath}`;
}

async function moveFile(srcPath, destPath) {
  await fs.rename(srcPath, destPath);
  return `File moved: ${srcPath} -> ${destPath}`;
}

async function deleteFileOrDir(targetPath) {
  try {
    const stats = await fs.lstat(targetPath);
    if (stats.isDirectory()) {
      await fs.rm(targetPath, { recursive: true, force: true });
      return `Directory deleted: ${targetPath}`;
    } else {
      await fs.unlink(targetPath);
      return `File deleted: ${targetPath}`;
    }
  } catch {
    return `Path does not exist: ${targetPath}`;
  }
}

async function dirTouch(dirPath, stats) {
  await fs.utimes(dirPath, stats.atime, stats.mtime);
  if (stats.mode) {
    await fs.chmod(dirPath, stats.mode);
  }
  return `Directory timestamps and mode updated: ${dirPath}`;
}