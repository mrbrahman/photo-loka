import * as fs from 'fs';
import { db } from '../app/database/sqlite-database.mjs';
import { extractFaceThumbnailsFromML } from '../app/core/media/face-extractor.mjs';

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error('Usage: node scripts/load-face-results.mjs <file1.json> [file2.json] ...');
  process.exit(1);
}

function jsonOrNull(val) {
  return val != null ? JSON.stringify(val) : null;
}

const deleteFaces = db.prepare(`DELETE FROM face_recognition WHERE uuid = ?`);
const deleteUnmatched = db.prepare(`DELETE FROM face_recognition_unmatched WHERE uuid = ?`);
const getFilename = db.prepare(`SELECT filename FROM metadata WHERE uuid = ?`);

const insertFace = db.prepare(`
  INSERT INTO face_recognition (
    uuid, face_idx, person_name, gender, age, confidence,
    bbox, landmarks, pose,
    cluster_id, cluster_name, cluster_confidence,
    cluster_consensus_count, cluster_reference_image_ids,
    cluster_is_new, cluster_centroid,
    input_face_matched, input_face_name, input_face_confidence,
    input_face_match_strategy, input_face_bbox, input_face_centroid,
    name_mismatch, created_tm
  ) VALUES (
    @uuid, @face_idx, @person_name, @gender, @age, @confidence,
    @bbox, @landmarks, @pose,
    @cluster_id, @cluster_name, @cluster_confidence,
    @cluster_consensus_count, @cluster_reference_image_ids,
    @cluster_is_new, @cluster_centroid,
    @input_face_matched, @input_face_name, @input_face_confidence,
    @input_face_match_strategy, @input_face_bbox, @input_face_centroid,
    @name_mismatch, @created_tm
  )
`);

const insertUnmatched = db.prepare(`
  INSERT INTO face_recognition_unmatched (
    uuid, face_idx, name, x, y, w, h, centroid, created_tm
  ) VALUES (
    @uuid, @face_idx, @name, @x, @y, @w, @h, @centroid, @created_tm
  )
`);

const loadFile = db.transaction((filePath) => {
  const response = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const uuid = response.image_id;
  const mtime = fs.statSync(filePath).mtime;
  const created_tm = mtime.toISOString().replace('T', ' ').slice(0, 19);

  // Look up actual filename from metadata
  const row = getFilename.get(uuid);
  const imagePath = row?.filename;

  deleteFaces.run(uuid);
  deleteUnmatched.run(uuid);

  for (let i = 0; i < response.faces.length; i++) {
    const f = response.faces[i];
    insertFace.run({
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
      created_tm,
    });
  }

  for (let i = 0; i < response.unmatched_input_faces.length; i++) {
    const u = response.unmatched_input_faces[i];
    insertUnmatched.run({
      uuid,
      face_idx: i,
      name: u.name,
      x: u.x,
      y: u.y,
      w: u.w,
      h: u.h,
      centroid: jsonOrNull(u.centroid),
      created_tm,
    });
  }

  // Update metadata.faces with recognized person names
  const names = response.faces.map(f => f.person_name).filter(Boolean);
  db.prepare(`UPDATE metadata SET faces = ? WHERE uuid = ?`).run(JSON.stringify(names), uuid);

  return { uuid, imagePath, faces: response.faces, unmatched: response.unmatched_input_faces.length };
});

let total = 0;
let thumbErrors = 0;

for (const filePath of files) {
  try {
    const result = loadFile(filePath);
    console.log(`${filePath}: ${result.faces.length} faces, ${result.unmatched} unmatched (uuid: ${result.uuid})`);

    // Extract face thumbnails (async, outside transaction)
    if (result.imagePath && result.faces.length > 0) {
      try {
        await extractFaceThumbnailsFromML(result.uuid, result.imagePath, result.faces);
        console.log(`  thumbnails extracted`);
      } catch (err) {
        console.error(`  thumbnail extraction failed: ${err.message}`);
        thumbErrors++;
      }
    } else if (!result.imagePath) {
      console.warn(`  skipping thumbnails: uuid ${result.uuid} not found in metadata`);
    }

    total++;
  } catch (error) {
    console.error(`${filePath}: FAILED - ${error.message}`);
  }
}

console.log(`\nLoaded ${total}/${files.length} files${thumbErrors ? `, ${thumbErrors} thumbnail errors` : ''}`);
process.exit(0);
