import { startupConfig } from '#startup-config';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

export async function recognizeFaces(uuid, imagePath, orientation, xmpRegions) {
  const url = `${startupConfig.mlServiceUrl}/faces/recognize`;

  const body = {
    image_id: uuid,
    image_path: imagePath,
    orientation: orientation || 1,
  };

  if (xmpRegions) {
    body.xmp_regions = xmpRegions;
  }

  logger.info(`Calling ML face recognition for ${uuid}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ML service error ${response.status}: ${text}`);
  }

  return await response.json();
}

export async function nameFaceCluster(clusterId, name) {
  const response = await fetch(`${startupConfig.mlServiceUrl}/faces/${clusterId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ML service error ${response.status}: ${text}`);
  }
  return await response.json();
}

export async function updatePersonName(oldName, newName) {
  const response = await fetch(`${startupConfig.mlServiceUrl}/faces/update-name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_name: oldName, new_name: newName }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ML service error ${response.status}: ${text}`);
  }
  return await response.json();
}

export async function getFaceSuggestions(clusterId) {
  const response = await fetch(`${startupConfig.mlServiceUrl}/faces/suggestions?cluster_id=${encodeURIComponent(clusterId)}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ML service error ${response.status}: ${text}`);
  }
  return await response.json();
}

export async function searchByText(query) {
  const url = `${startupConfig.mlServiceUrl}/search/text`;
  logger.info(`Calling ML text search: ${query}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit: 1000 }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ML service error ${response.status}: ${text}`);
  }

  return await response.json();
}
