import * as fs from 'fs';
import * as path from 'path';
import {v4 as uuidv4} from 'uuid';
import { createLogger } from '#utils/logger';
import { fmtTime } from '#utils/time-format';

import * as exifManager from '#media/exif-manager';
import * as thumbnailManager from '#media/thumbnail-manager';
import * as videoProcessor from '#media/video-processor';
import * as faceExtractor from '#media/face-extractor';
import * as fileOps from './file-organizer.mjs';
import { addToIndexQueue } from './queue-manager.mjs';

import * as db from './indexer-db.mjs';
import { enqueue as enqueueGeoFinalize } from '#geo/geo-queue-manager';
import { insertGeoLookup } from '#geo/geo-encoding-db';
import { processFaceRecognition } from '#ml/ml-manager';
import {config} from '#runtime-config';
import {startupConfig} from '#startup-config';

const logger = createLogger(import.meta.url);

export async function indexFile(collection, sourceFileName, uuid, inPlace){
  // indexing is a series of steps, where the latter steps
  // are dependent on former steps
  logger.info(`Indexing ${sourceFileName}`);
  let fileStart = performance.now();

  // Step 1: Read metadata from file
  // unfortunately cannot pass buffer here
  try{
    var p = await exifManager.getMetadata(sourceFileName);
  } catch(error){
    throw `ERROR during getMetadata for file: ${sourceFileName}: ${error}`;
  }

  // Step 2: Place the file (intake = move to its computed folder; inPlace =
  // just inspect the folder and split into album_date/album_name).
  //
  // captureDateTime is the actual camera capture time from EXIF (null when
  // no EXIF date is available). For in-place, album_date is derived from the
  // folder via the pattern engine regardless. For intake, files without EXIF
  // dates should not be present (intake relies on EXIF dates for folder
  // placement); if it happens, album_date defaults to '1970-01-01' as a sentinel.
  try{
    var f = await fileOps.placeFileInCollection(collection, sourceFileName, p.captureDateTime, inPlace);
  } catch(error){
    throw `ERROR during placeFileInCollection for file: ${sourceFileName}: ${error}`;
  }

  // Step 3: Generate uuid, and make metadata current. f provides
  // {album_date, album_name, filename}; merging onto p gives the full row.
  try{
    p = {...p, ...f, uuid: uuid ? uuid : uuidv4(), collection_id: collection.collection_id}
  } catch(error){
    throw `ERROR during Generate uuid for file: ${sourceFileName}: ${error}`;
  }

  // Step 3b: Derive capture_date, capture_time, capture_tz_offset from
  // captureDateTime (structured object from exif-manager, extracted directly
  // from ExifDateTime properties -- no string parsing).
  // capture_tz_name is already set by exif-manager (from GeolocationTimeZone).
  if (p.captureDateTime) {
    const cdt = p.captureDateTime;
    p.capture_date = `${String(cdt.year).padStart(4, '0')}-${String(cdt.month).padStart(2, '0')}-${String(cdt.day).padStart(2, '0')}`;
    p.capture_time = `${String(cdt.hour).padStart(2, '0')}:${String(cdt.minute).padStart(2, '0')}:${String(cdt.second).padStart(2, '0')}`;
    if (cdt.tzOffsetMinutes != null) {
      const sign = cdt.tzOffsetMinutes >= 0 ? '+' : '-';
      const abs = Math.abs(cdt.tzOffsetMinutes);
      const h = String(Math.floor(abs / 60)).padStart(2, '0');
      const m = String(abs % 60).padStart(2, '0');
      p.capture_tz_offset = `${sign}${h}:${m}`;
    } else {
      p.capture_tz_offset = null;
    }
  } else {
    p.capture_date = null;
    p.capture_time = null;
    p.capture_tz_offset = null;
  }
  delete p.captureDateTime;
  // capture_tz_name is already on p from exif-manager

  // Step 4: Video thumbnail extraction
  if(p.mediatype == "video" || p.mediatype == "image"){

    let imageFileName = p.filename;
    if(p.mediatype == "video"){
      try{
        // extract video thumbnail (screenshot) and use that image to extract image thumbs
        imageFileName = await thumbnailManager.generateVideoThumbnail(p.uuid, p.filename);
      } catch(error){
        throw `ERROR during video processing for file: ${p.filename}: ${error}`;
      }
    }

    // read image once
    let buf;
    try{
      buf = fs.readFileSync(imageFileName);
    } catch(error){
      throw `ERROR during readFileSync before thumbnail ${sourceFileName} ${error}`
    }

    // thumbnails generation
    try{
      await thumbnailManager.createImageThumbnails(p.uuid, buf);
    } catch(error){
      throw `ERROR during createImageThumbnails for file: ${sourceFileName}: ${error}`;
    }

    // Step 5: video compression to help with streaming on browsers
    try{
      if(p.mediatype == "video"){
        // Check for pre-compressed webm file
        const baseName = path.basename(sourceFileName, path.extname(sourceFileName));
        const sourceDir = path.dirname(sourceFileName);
        const preCompressedWebm = path.join(sourceDir, `${baseName}_compressed_video.webm`);

        if(fs.existsSync(preCompressedWebm)){
          // Move pre-compressed webm to thumbnail directory
          const thumbsDir = path.join(
            startupConfig.thumbsDir,
            ...Array.from(p.uuid).slice(0,3),
            `${p.uuid}_compressed_video.webm`
          );
          await fileOps.moveItem(null, preCompressedWebm, thumbsDir, true);
          logger.info(`Moved pre-compressed webm: ${preCompressedWebm}`);
        } else {
          if(collection.compress_videos){
            // perform video compression to help with streaming
            // add to the 'low' priority indexing queue
            addToIndexQueue(videoProcessor.compressVideo, [p.uuid, p.filename], 'low');
          } else {
            logger.info(`Skipping video compression (not enabled for collection) for file: ${p.uuid} ${p.filename}`);
          }
        }
      }
    } catch(error){
      throw `ERROR during video compression for file: ${sourceFileName}: ${error}`;
    }

    // Step 6: face region extraction - skipped, now handled by ML face recognition (Step 9)
  }

  // grab the exiftool geo data before sending to DB (it's no longer stored in metadata)
  let exiftoolGeoJson = p.exiftool_geo_json;
  let countryCode = exiftoolGeoJson?.GeolocationCountryCode;

  // Remove exiftool_geo_json from the row object (not a metadata column)
  // geo_ fields are left null -- they are populated by the geo finalizer
  delete p.exiftool_geo_json;

  // save xmpregion before DB insert mutates it to a JSON string
  let xmpregionRaw = p.xmpregion;

  // Step 8: Make an entry in db
  await db.insertMetadataRow(p);

  // Store exiftool geo data in geo_lookups table
  if (exiftoolGeoJson && Object.values(exiftoolGeoJson).some(v => v != null)) {
    await insertGeoLookup(p.uuid, 'exiftool', 'geolocation', null, JSON.stringify(exiftoolGeoJson));
  }

  // -------------------------
  // Enrichments
  // -------------------------
  // Step 7: Queue geo finalization if GPS coordinates are available
  if (p.gps_lat && p.gps_lng) {
    enqueueGeoFinalize(p.uuid, { gps_lat: p.gps_lat, gps_lng: p.gps_lng, country_code: countryCode });
  }

  // Step 9: Queue face recognition for images
  if (p.mediatype === 'image') {
    if (config.performFaceRecognition) {
      addToIndexQueue(processFaceRecognition, [p.uuid, p.filename, p.orientation, xmpregionRaw], 'normal');
    } else {
      logger.info(`Skipping face recognition as per config for file: ${p.uuid} ${p.filename}`);
    }
  }

  logger.info(`Indexing of ${sourceFileName} finished in ${fmtTime(performance.now()-fileStart)}`);
}
