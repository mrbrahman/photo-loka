import { recognizeFaces, nameFaceCluster as mlNameCluster, updatePersonName as mlUpdatePersonName, getFaceSuggestions as mlGetFaceSuggestions } from './ml-client.mjs';
import * as mlDb from './ml-db.mjs';
import { extractFaceThumbnailsFromML } from '#media/face-extractor';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

export async function processFaceRecognition(uuid, imagePath, orientation, xmpRegions) {
  // If called with just uuid, look up the rest from metadata
  if (!imagePath) {
    const item = await mlDb.getItemForRecognition(uuid);
    if (!item) throw new Error(`Item not found: ${uuid}`);
    imagePath = item.filename;
    orientation = parseInt(item.orientation) || 1;
    xmpRegions = item.xmpregion ? JSON.parse(item.xmpregion) : null;
  }

  const result = await recognizeFaces(uuid, imagePath, orientation, xmpRegions);
  await mlDb.saveFaceRecognitionResults(uuid, result);

  // Extract face thumbnails
  if (result.faces.length > 0) {
    await extractFaceThumbnailsFromML(uuid, imagePath, result.faces);
  }

  return result;
}

export async function getClusterIdByUuidAndName(uuid, personName) {
  return await mlDb.getClusterIdByUuidAndName(uuid, personName);
}

export async function getFacesByUuid(uuid) {
  return await mlDb.getFacesByUuid(uuid);
}

export async function getFacesByPerson(personName) {
  return await mlDb.getFacesByPerson(personName);
}

export async function getUnmatchedByUuid(uuid) {
  return await mlDb.getUnmatchedByUuid(uuid);
}

export async function nameFaceCluster(clusterId, name) {
  await mlNameCluster(clusterId, name);
  const count = await mlDb.nameFaceCluster(clusterId, name);
  logger.info(`Named cluster ${clusterId} as '${name}', ${count} faces updated`);
  return count;
}

export async function updatePersonName(oldName, newName) {
  await mlUpdatePersonName(oldName, newName);
  const count = await mlDb.updatePersonName(oldName, newName);
  logger.info(`Renamed '${oldName}' to '${newName}', ${count} faces updated`);
  return count;
}

export async function getFaceSuggestions(clusterId) {
  return await mlGetFaceSuggestions(clusterId);
}

export async function dismissCluster(clusterId) {
  await mlDb.dismissCluster(clusterId);
  logger.info(`Dismissed cluster ${clusterId}`);
}

export async function undismissCluster(clusterId) {
  await mlDb.undismissCluster(clusterId);
  logger.info(`Undismissed cluster ${clusterId}`);
}
