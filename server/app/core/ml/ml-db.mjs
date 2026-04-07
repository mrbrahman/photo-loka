import { asyncRun, asyncAll, asyncGet } from '#db/db-pool';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

const deleteFacesStatement = `DELETE FROM face_recognition WHERE uuid = ?`;
const deleteUnmatchedStatement = `DELETE FROM face_recognition_unmatched WHERE uuid = ?`;

const insertFaceStatement = `
  INSERT INTO face_recognition (
    uuid, face_idx, person_name, gender, age, confidence,
    bbox, landmarks, pose,
    cluster_id, cluster_name, cluster_confidence,
    cluster_consensus_count, cluster_reference_image_ids,
    cluster_is_new, cluster_centroid,
    input_face_matched, input_face_name, input_face_confidence,
    input_face_match_strategy, input_face_bbox, input_face_centroid,
    name_mismatch
  ) VALUES (
    @uuid, @face_idx, @person_name, @gender, @age, @confidence,
    @bbox, @landmarks, @pose,
    @cluster_id, @cluster_name, @cluster_confidence,
    @cluster_consensus_count, @cluster_reference_image_ids,
    @cluster_is_new, @cluster_centroid,
    @input_face_matched, @input_face_name, @input_face_confidence,
    @input_face_match_strategy, @input_face_bbox, @input_face_centroid,
    @name_mismatch
  )
`;

const insertUnmatchedStatement = `
  INSERT INTO face_recognition_unmatched (
    uuid, face_idx, name, x, y, w, h, centroid
  ) VALUES (
    @uuid, @face_idx, @name, @x, @y, @w, @h, @centroid
  )
`;

function jsonOrNull(val) {
  return val != null ? JSON.stringify(val) : null;
}

export async function getItemForRecognition(uuid) {
  return await asyncGet(`
    SELECT filename, orientation, xmpregion
    FROM metadata
    WHERE uuid = ?
  `, uuid);
}

export async function saveFaceRecognitionResults(uuid, response) {
  // Clear previous results for this image
  await asyncRun(deleteFacesStatement, uuid);
  await asyncRun(deleteUnmatchedStatement, uuid);

  // Insert detected faces
  for (let i = 0; i < response.faces.length; i++) {
    const f = response.faces[i];
    await asyncRun(insertFaceStatement, {
      uuid,
      face_idx: i,
      person_name: f.person_name,
      gender: f.gender,
      age: f.age,
      confidence: f.confidence,
      bbox: jsonOrNull(f.bbox),
      landmarks: jsonOrNull(f.landmarks),
      pose: jsonOrNull(f.pose),
      cluster_id: f.cluster.cluster_id,
      cluster_name: f.cluster.name,
      cluster_confidence: f.cluster.confidence,
      cluster_consensus_count: f.cluster.consensus_count,
      cluster_reference_image_ids: jsonOrNull(f.cluster.reference_image_ids),
      cluster_is_new: f.cluster.is_new_cluster ? 1 : 0,
      cluster_centroid: jsonOrNull(f.cluster.centroid),
      input_face_matched: f.input_face_match.matched != null ? (f.input_face_match.matched ? 1 : 0) : null,
      input_face_name: f.input_face_match.name,
      input_face_confidence: f.input_face_match.confidence,
      input_face_match_strategy: f.input_face_match.match_strategy,
      input_face_bbox: jsonOrNull(f.input_face_match.input_bbox),
      input_face_centroid: jsonOrNull(f.input_face_match.centroid),
      name_mismatch: f.name_mismatch != null ? (f.name_mismatch ? 1 : 0) : null,
    });
  }

  // Insert unmatched input faces
  for (let i = 0; i < response.unmatched_input_faces.length; i++) {
    const u = response.unmatched_input_faces[i];
    await asyncRun(insertUnmatchedStatement, {
      uuid,
      face_idx: i,
      name: u.name,
      x: u.x,
      y: u.y,
      w: u.w,
      h: u.h,
      centroid: jsonOrNull(u.centroid),
    });
  }

  logger.info(`Saved ${response.faces.length} faces and ${response.unmatched_input_faces.length} unmatched for ${uuid}`);

  // Update metadata.faces with recognized person names
  const names = response.faces.map(f => f.person_name).filter(Boolean);
  await asyncRun(`UPDATE metadata SET faces = ? WHERE uuid = ?`, JSON.stringify(names), uuid);
}

export async function getFacesByUuid(uuid) {
  return await asyncAll(`SELECT * FROM face_recognition WHERE uuid = ?`, uuid);
}

export async function getFacesByPerson(personName) {
  return await asyncAll(`SELECT * FROM face_recognition WHERE person_name = ?`, personName);
}

export async function getUnmatchedByUuid(uuid) {
  return await asyncAll(`SELECT * FROM face_recognition_unmatched WHERE uuid = ?`, uuid);
}
