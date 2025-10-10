import path from 'path'
import * as backupDb from './sync-db.mjs';
import * as backupOps from './sync-operations.mjs';
import { computeBackupOperations } from './compute-sync-operations.mjs';
import { getCollection } from '#collections/collection-manager';
import { getConnectedDevices } from './device-detector.mjs';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

// registration is by device id and collection
// each device can host one or many collections

export async function registerDeviceForCollection(deviceId, deviceName, deviceDesc, collectionId, backupPath, lastBackupId = 0) {
  logger.info(`Registering backup device: ${deviceId} (${deviceName}) for collection ${collectionId}`);
  await backupDb.registerDevice(deviceId, deviceName, deviceDesc, collectionId, backupPath, lastBackupId);
}

export async function getAllBackupRegistrations() {
  return await backupDb.getAllBackupRegistrations();
}

// the main function that co-ordinates backup for a given device id and collection id
export async function backupCollection(deviceId, collectionId, mountpoint, dryRun = false) {
  logger.info(`Starting ${dryRun ? 'dry run ' : ''}backup for device ${deviceId}, collection ${collectionId}`);
  
  try {
    // Get last backup details
    const {lastBackupStatus, lastBackupId} = await backupDb.getLastBackupDetails(deviceId, collectionId);
    if (lastBackupStatus != 'SUCCESS') {
      throw new Error(`Previous backup for device ${deviceId}, collection ${collectionId} failed. Please resolve the issue and update the status to proceed.`);
    }
    
    logger.info(`Last backup ID for device ${deviceId}, collection ${collectionId} is ${lastBackupId}`);
    const maxId = await backupDb.getMaxAuditLogId(collectionId);
    
    if (maxId <= lastBackupId) {
      logger.info('No changes to backup');
      return { success: true, operations: [], summary: { successful: 0, failed: 0, total: 0 } };
    }
    
    // Fetch changes within the determined range for this collection
    const changes = await backupDb.getChangesFromAuditLog(lastBackupId, maxId, collectionId);
    
    // Get collection details
    const collection = await getCollection(collectionId);
    if (!collection) {
      throw new Error(`Collection ${collectionId} not found`);
    }
    
    const listenPaths = collection.listen_paths;
    const collectionPaths = [collection.collection_path];
    
    logger.info(`Processing ${changes.length} changes from audit log`);
    
    // Get device backup path
    const device = await backupDb.getDevice(deviceId, collectionId);
    if (!device) {
      throw new Error(`Device ${deviceId} for collection ${collectionId} not found`);
    }
    
    // Compute effective backup operations
    const targetPath = path.join(mountpoint, device.backup_path);
    const operations = await computeBackupOperations(changes, listenPaths, collectionPaths, targetPath);
    logger.info(`Computed ${operations.length} backup operations`);
    
    if (dryRun) {
      logger.info('Dry run - operations that would be performed:');
      operations.forEach((op, i) => {
        logger.info(`${i + 1}. ${op.action}: ${op.path1 || 'null'} -> ${op.path2 || 'null'} ${op.stats ? `(stats: ${JSON.stringify(op.stats)})` : ''}`);
      });
      return {
        success: true,
        operations: operations.map(op => ({ ...op, success: true, result: 'Dry run - not executed' })),
        summary: { successful: operations.length, failed: 0, skipped: 0, total: operations.length }
      };
    }
    
    // Execute backup operations
    const results = await backupOps.executeBackupOperations(operations);
    
    
    // Log summary
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    const skipped = operations.length - results.length;

    // There is no clean way to handle failures - as we're trying to do incremental backups.
    // If there are failures, we may have done some operations, even some future ones,
    // but there is no way to exactly figure out where to resume from failure.

    // Hence, we update the status to 'FAILED' so we don't auto backup anymore
    // until the user manually intervenes (e.g. do manual rsync, and then set status to SUCCESS)
    if (failed == 0){
      // Update backup ID to the determined max ID
      await backupDb.updateBackupResult(deviceId, collectionId, 'SUCCESS', maxId);
    } else {
      // In case of failures, do not advance last backup ID
      await backupDb.updateBackupResult(deviceId, collectionId, 'FAILED', lastBackupId);
    }
    
    logger.info(`Backup completed: ${successful} successful, ${failed} failed, ${skipped} skipped operations`);
    
    return {
      success: failed === 0,
      operations: results,
      summary: { successful, failed, skipped, total: operations.length }
    };
    
  } catch (error) {
    logger.error(`Backup failed for device ${deviceId}:`, error.message);
    throw error;
  }
}


async function backupDeviceCollections(deviceId, mountpoint, deviceCollections, dryRun) {
  const results = [];
  
  for (const deviceCollection of deviceCollections) {
    try {
      const result = await backupCollection(deviceId, deviceCollection.collection_id, mountpoint, dryRun);
      results.push({ deviceId, collectionId: deviceCollection.collection_id, success: true, result });
    } catch (error) {
      logger.error(`Backup failed for device ${deviceId}, collection ${deviceCollection.collection_id}:`, error.message);
      results.push({ deviceId, collectionId: deviceCollection.collection_id, success: false, error: error.message });
    }
  }
  
  return results;
}

// backup to a single device on request (need device id to be given)
export async function backupToDevice(deviceId, dryRun = false) {
  logger.info(`Backing up to device ${deviceId}`);
  
  const connectedDevices = await getConnectedDevices();
  const connectedDevice = connectedDevices.find(d => d.uuid === deviceId);
  
  if (!connectedDevice) {
    throw new Error(`Device ${deviceId} not connected`);
  }
  
  const deviceCollections = await backupDb.getDeviceRegistrations(deviceId);
  
  if (deviceCollections.length === 0) {
    throw new Error(`Device ${deviceId} not registered for any collections`);
  }
  
  logger.info(`Found device: ${deviceCollections[0].device_name} (${deviceId}) with ${deviceCollections.length} collections`);
  
  return await backupDeviceCollections(deviceId, connectedDevice.mountpoint, deviceCollections, dryRun);
}


// backup to all connected devices that are registered

export async function backupToConnectedDevices(dryRun = false) {
  logger.info('Checking for connected devices...');
  
  const connectedDevices = await getConnectedDevices();
  const registeredDevices = await backupDb.getAllBackupRegistrations();
  
  const results = [];
  
  for (const connectedDevice of connectedDevices) {
    const deviceCollections = registeredDevices.filter(d => d.device_id === connectedDevice.uuid);
    
    if (deviceCollections.length > 0) {
      logger.info(`Found registered device: ${deviceCollections[0].device_name} (${connectedDevice.uuid}) with ${deviceCollections.length} collections`);
      
      const deviceResults = await backupDeviceCollections(connectedDevice.uuid, connectedDevice.mountpoint, deviceCollections, dryRun);
      results.push(...deviceResults);
    } else {
      logger.info(`Connected device ${connectedDevice.uuid} not registered for any collections`);
    }
  }
  
  return results;
}
