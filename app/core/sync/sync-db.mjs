import { asyncGet, asyncAll, asyncRun } from '#db/db-pool';

export async function registerDevice(deviceId, deviceName, deviceDesc, collectionId, backupPath, lastSyncId = 0) {
  await asyncRun(`
    INSERT OR REPLACE INTO sync_status 
    (device_id, device_name, device_desc, collection_id, backup_path, last_sync_id) 
    VALUES 
    (@deviceId, @deviceName, @deviceDesc, @collectionId, @backupPath, @lastSyncId)
  `, {deviceId, deviceName, deviceDesc, collectionId, backupPath, lastSyncId});
}

export async function getLastSyncId(deviceId, collectionId) {
  const result = await asyncGet(`
    SELECT last_sync_id FROM sync_status WHERE device_id = @deviceId AND collection_id = @collectionId
  `, {deviceId, collectionId});
  return result?.last_sync_id || 0;
}

export async function updateLastSyncId(deviceId, collectionId, syncId) {
  await asyncRun(`
    UPDATE sync_status SET last_sync_id = @syncId WHERE device_id = @deviceId AND collection_id = @collectionId
  `, {syncId, deviceId, collectionId});
}

export async function getAllSyncRegistrations() {
  return await asyncAll(`
    SELECT device_id, device_name, device_desc, collection_id, backup_path, last_sync_id 
    FROM sync_status
  `);
}

export async function getDeviceRegistrations(deviceId) {
  return await asyncAll(`
    SELECT device_id, device_name, device_desc, collection_id, backup_path, last_sync_id 
    FROM sync_status WHERE device_id = @deviceId
  `, {deviceId});
}

export async function getDevice(deviceId, collectionId) {
  return await asyncGet(`
    SELECT device_id, device_name, device_desc, collection_id, backup_path, last_sync_id 
    FROM sync_status WHERE device_id = @deviceId AND collection_id = @collectionId
  `, {deviceId, collectionId});
}

export async function getMaxAuditLogId(collectionId) {
  const result = await asyncGet(`SELECT MAX(id) as max_id FROM file_audit_log WHERE collection_id = @collectionId`, {collectionId});
  return result?.max_id || 0;
}

export async function getChangesFromAuditLog(lastSyncId, maxId, collectionId) {
  return await asyncAll(`
    SELECT action, path1, path2, id
    FROM file_audit_log 
    WHERE id > @lastSyncId AND id <= @maxId AND collection_id = @collectionId
    ORDER BY id
  `, {lastSyncId, maxId, collectionId});
}
