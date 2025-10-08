import path from 'path'
import * as syncDb from './sync-db.mjs';
import * as syncOps from './sync-operations.mjs';
import { computeSyncOperations } from './compute-sync-operations.mjs';
import { getCollection } from '#collections/collection-manager';
import { getConnectedDevices } from './device-detector.mjs';

// registration is by device id and collection
// each device can host one or many collections

export async function registerDeviceForCollection(deviceId, deviceName, deviceDesc, collectionId, backupPath, lastSyncId = 0) {
  console.log(`Registering sync device: ${deviceId} (${deviceName}) for collection ${collectionId}`);
  await syncDb.registerDevice(deviceId, deviceName, deviceDesc, collectionId, backupPath, lastSyncId);
}

export async function getAllSyncRegistrations() {
  return await syncDb.getAllSyncRegistrations();
}

// the main function that co-ordinates sync for a given device id and collection id
export async function syncCollection(deviceId, collectionId, mountpoint, dryRun = false) {
  console.log(`Starting ${dryRun ? 'dry run ' : ''}sync for device ${deviceId}, collection ${collectionId}`);
  
  try {
    // Get last sync ID and max audit log ID
    const lastSyncId = await syncDb.getLastSyncId(deviceId, collectionId);
    const maxId = await syncDb.getMaxAuditLogId(collectionId);
    
    if (maxId <= lastSyncId) {
      console.log('No changes to sync');
      return { success: true, operations: [], summary: { successful: 0, failed: 0, total: 0 } };
    }
    
    // Fetch changes within the determined range for this collection
    const changes = await syncDb.getChangesFromAuditLog(lastSyncId, maxId, collectionId);
    
    // Get collection details
    const collection = await getCollection(collectionId);
    if (!collection) {
      throw new Error(`Collection ${collectionId} not found`);
    }
    
    const listenPaths = collection.listen_paths;
    const collectionPaths = [collection.collection_path];
    
    console.log(`Processing ${changes.length} changes from audit log`);
    
    // Get device backup path
    const device = await syncDb.getDevice(deviceId, collectionId);
    if (!device) {
      throw new Error(`Device ${deviceId} for collection ${collectionId} not found`);
    }
    
    // Compute effective sync operations
    const targetPath = path.join(mountpoint, device.backup_path);
    const operations = await computeSyncOperations(changes, listenPaths, collectionPaths, targetPath);
    console.log(`Computed ${operations.length} sync operations`);
    
    if (dryRun) {
      console.log('Dry run - operations that would be performed:');
      operations.forEach((op, i) => {
        console.log(`${i + 1}. ${op.action}: ${op.path1 || 'null'} -> ${op.path2 || 'null'} ${op.stats ? `(stats: ${JSON.stringify(op.stats)})` : ''}`);
      });
      return {
        success: true,
        operations: operations.map(op => ({ ...op, success: true, result: 'Dry run - not executed' })),
        summary: { successful: operations.length, failed: 0, skipped: 0, total: operations.length }
      };
    }
    
    // Execute sync operations
    const results = await syncOps.executeSyncOperations(operations);
    
    
    // Log summary
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    const skipped = operations.length - results.length;

    // TODO: need to better handle failures
    if (failed == 0){
      // Update sync ID to the determined max ID
      await syncDb.updateLastSyncId(deviceId, collectionId, maxId);
    }
    
    console.log(`Sync completed: ${successful} successful, ${failed} failed, ${skipped} skipped operations`);
    
    return {
      success: failed === 0,
      operations: results,
      summary: { successful, failed, skipped, total: operations.length }
    };
    
  } catch (error) {
    console.error(`Sync failed for device ${deviceId}:`, error.message);
    throw error;
  }
}



async function syncDeviceCollections(deviceId, mountpoint, deviceCollections, dryRun) {
  const results = [];
  
  for (const deviceCollection of deviceCollections) {
    try {
      const result = await syncCollection(deviceId, deviceCollection.collection_id, mountpoint, dryRun);
      results.push({ deviceId, collectionId: deviceCollection.collection_id, success: true, result });
    } catch (error) {
      console.error(`Sync failed for device ${deviceId}, collection ${deviceCollection.collection_id}:`, error.message);
      results.push({ deviceId, collectionId: deviceCollection.collection_id, success: false, error: error.message });
    }
  }
  
  return results;
}

// sync a single device on request (need device id to be given)
export async function syncDevice(deviceId, dryRun = false) {
  console.log(`Syncing device ${deviceId}`);
  
  const connectedDevices = await getConnectedDevices();
  const connectedDevice = connectedDevices.find(d => d.uuid === deviceId);
  
  if (!connectedDevice) {
    throw new Error(`Device ${deviceId} not connected`);
  }
  
  const deviceCollections = await syncDb.getDeviceRegistrations(deviceId);
  
  if (deviceCollections.length === 0) {
    throw new Error(`Device ${deviceId} not registered for any collections`);
  }
  
  console.log(`Found device: ${deviceCollections[0].device_name} (${deviceId}) with ${deviceCollections.length} collections`);
  
  return await syncDeviceCollections(deviceId, connectedDevice.mountpoint, deviceCollections, dryRun);
}


// sync all connected devices that are registered

export async function syncConnectedDevices(dryRun = false) {
  console.log('Checking for connected devices...');
  
  const connectedDevices = await getConnectedDevices();
  const registeredDevices = await syncDb.getAllSyncRegistrations();
  
  const results = [];
  
  for (const connectedDevice of connectedDevices) {
    const deviceCollections = registeredDevices.filter(d => d.device_id === connectedDevice.uuid);
    
    if (deviceCollections.length > 0) {
      console.log(`Found registered device: ${deviceCollections[0].device_name} (${connectedDevice.uuid}) with ${deviceCollections.length} collections`);
      
      const deviceResults = await syncDeviceCollections(connectedDevice.uuid, connectedDevice.mountpoint, deviceCollections, dryRun);
      results.push(...deviceResults);
    } else {
      console.log(`Connected device ${connectedDevice.uuid} not registered for any collections`);
    }
  }
  
  return results;
}
