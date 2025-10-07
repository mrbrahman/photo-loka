import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function getConnectedDevicesLinux() {
  try {
    const { stdout } = await execAsync('lsblk -Jno UUID,MOUNTPOINT');
    const data = JSON.parse(stdout);
    return data.blockdevices.filter(device => device.uuid && device.mountpoint);
  } catch (error) {
    console.error('Failed to get connected devices (Linux):', error.message);
    return [];
  }
}

async function getConnectedDevicesWindows() {
  try {
    const { stdout } = await execAsync('powershell "Get-Volume | Where-Object {$_.DriveType -eq \'Removable\'} | ConvertTo-Json"');
    const volumes = JSON.parse(stdout);
    const volumeArray = Array.isArray(volumes) ? volumes : [volumes];
    
    return volumeArray.map(volume => ({
      uuid: volume.UniqueId || volume.ObjectId,
      mountpoint: `${volume.DriveLetter}:\\`
    })).filter(device => device.uuid && device.mountpoint);
  } catch (error) {
    console.error('Failed to get connected devices (Windows):', error.message);
    return [];
  }
}

async function getConnectedDevicesMacOS() {
  try {
    const { stdout } = await execAsync('diskutil list -plist external');
    // Note: This would need XML parsing for full implementation
    // For now, return empty array as placeholder
    console.warn('macOS device detection not fully implemented');
    return [];
  } catch (error) {
    console.error('Failed to get connected devices (macOS):', error.message);
    return [];
  }
}

export async function getConnectedDevices() {
  const platform = os.platform();
  
  switch (platform) {
    case 'linux':
      return await getConnectedDevicesLinux();
    case 'win32':
      return await getConnectedDevicesWindows();
    case 'darwin':
      return await getConnectedDevicesMacOS();
    default:
      console.warn(`Unsupported platform for device detection: ${platform}`);
      return [];
  }
}