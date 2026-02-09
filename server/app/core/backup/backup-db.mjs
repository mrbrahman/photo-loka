import { asyncGet, asyncAll, asyncRun } from '#db/db-pool';

export async function registerDevice(deviceId, deviceName, deviceDesc, collectionId, backupPath, lastBackupId = 0) {
  await asyncRun(`
    INSERT OR REPLACE INTO backup_status 
    (device_id, device_name, device_desc, collection_id, backup_path, last_backup_id) 
    VALUES 
    (@deviceId, @deviceName, @deviceDesc, @collectionId, @backupPath, @lastBackupId)
  `, {deviceId, deviceName, deviceDesc, collectionId, backupPath, lastBackupId});
}

export async function getLastBackupDetails(deviceId, collectionId) {
  const result = await asyncGet(`
    SELECT last_backup_status, last_backup_id
    FROM backup_status 
    WHERE device_id = @deviceId 
    AND collection_id = @collectionId
  `, {deviceId, collectionId});
  return {
    lastBackupStatus: result?.last_backup_status || 'SUCCESS',
    lastBackupId: result?.last_backup_id || 0
  };
}

export async function updateBackupResult(deviceId, collectionId, backupStatus, backupId) {
  await asyncRun(`
    UPDATE backup_status 
    SET last_backup_id = @backupId, 
      last_backup_status = @backupStatus
    WHERE device_id = @deviceId 
    AND collection_id = @collectionId
  `, {backupId, deviceId, backupStatus, collectionId});
}

export async function getAllBackupRegistrations() {
  return await asyncAll(`
    SELECT device_id, device_name, device_desc, collection_id, backup_path, last_backup_id 
    FROM backup_status
  `);
}

export async function getDeviceRegistrations(deviceId) {
  return await asyncAll(`
    SELECT device_id, device_name, device_desc, collection_id, backup_path, last_backup_id 
    FROM backup_status WHERE device_id = @deviceId
  `, {deviceId});
}

export async function getDevice(deviceId, collectionId) {
  return await asyncGet(`
    SELECT device_id, device_name, device_desc, collection_id, backup_path, last_backup_id 
    FROM backup_status WHERE device_id = @deviceId AND collection_id = @collectionId
  `, {deviceId, collectionId});
}

export async function getMaxAuditLogId(collectionId) {
  const result = await asyncGet(`SELECT MAX(id) as max_id FROM file_audit_log WHERE collection_id = @collectionId`, {collectionId});
  return result?.max_id || 0;
}

export async function getChangesFromAuditLog(lastBackupId, maxId, collectionId) {
  return await asyncAll(`
    SELECT action, path1, path2, id
    FROM file_audit_log 
    WHERE id > @lastBackupId AND id <= @maxId AND collection_id = @collectionId
    ORDER BY id
  `, {lastBackupId, maxId, collectionId});
}
