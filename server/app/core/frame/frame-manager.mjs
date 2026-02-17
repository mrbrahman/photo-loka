import * as db from './frame-db.mjs';
import * as search from '#search/search-engine';

import { createLogger } from '#utils/logger';
import { AppError } from '#utils/app-error';

const logger = createLogger(import.meta.url);

const frameItems = {};

export async function createNewFrame(entry){
  let frame_id = await db.createNewFrame(entry);
  
  let items = await getItemsForFrame(frame_id);

  // store the items for the frame id
  frameItems[entry.frame_ip_addr] = {
    items: items,
    curr_idx: -1,
    autoPaused: false,
    pauseEndTime: null,
    manualPaused: false
  };

  return frame_id;
}

export async function loadAllFrames() {
  logger.info("Loading data for all frames...")

  let frames = await getAllFrames();
  for (let frame of frames){
    let items = await getItemsForFrame(frame.frame_id);

    // store the items for the frame id
    frameItems[frame.frame_ip_addr] = {
      items: items,
      curr_idx: -1,
      autoPaused: false,
      pauseEndTime: null,
      manualPaused: false
    };
    logger.info(`Data for frame ${frame.frame_ip_addr} loaded with ${items.length} items`);
  }

  logger.info(`Data for ${frames.length} frame(s) loaded`);
}


export function getNextItem(frame_ip_addr){
  if (!frameItems[frame_ip_addr]) {
    throw new AppError(`No frame setup for IP address: ${frame_ip_addr}`, 'NotFoundError', 'NO_FRAME_SETUP', 404);
  }

  let frame = frameItems[frame_ip_addr];
  if (frame.manualPaused) {
    throw new AppError('Frame is manually paused', 'FramePausedError', 'FRAME_PAUSED', 423);
  }

  // check if frame is in auto pause window
  // TODO

  // increment the index and return the item
  return frame.items[++frame.curr_idx];
}

export function getPrevItem(frame_ip_addr){
  if (!frameItems[frame_ip_addr]) {
    throw new AppError(`No frame setup for IP address: ${frame_ip_addr}`, 'NotFoundError', 'NO_FRAME_SETUP', 404);
  }
  
  let frame = frameItems[frame_ip_addr];
  if (frame.manualPaused) {
    throw new AppError('Frame is manually paused', 'FramePausedError', 'FRAME_PAUSED', 423);
  }

  // check if frame is in auto pause window
  // TODO

  // decrement the index and return the item
  if (frame.curr_idx == -1 || frame.curr_idx == 0) {
    frame.curr_idx = frame.items.length
  }
  return frame.items[--frame.curr_idx];
}

/**
 * Checks if the current time falls within a range string.
 * @param {string} rangeStr - The window in "HH:mm-HH:mm" format.
 * @param {Date} [currentTime=new Date()] - Optional date to check against.
 * @returns {boolean} - Returns true if the time falls within the window.
 */
function inPauseWindow(rangeStr, currentTime = new Date()) {
  // 1. Helper to convert HH:mm to total minutes from start of day
  const toMins = (timeStr) => {
    const [h, m] = timeStr.trim().split(':').map(Number);
    return h * 60 + m;
  };

  // 2. Parse the range and current time
  const [startStr, endStr] = rangeStr.split('-');
  const start = toMins(startStr);
  const end = toMins(endStr);
  const now = currentTime.getHours() * 60 + currentTime.getMinutes();

  // 3. Logic for standard vs. overnight windows
  if (start <= end) {
    // Normal range (e.g., "09:00-17:00")
    return now >= start && now <= end;
  } else {
    // Overnight range (e.g., "22:00-04:00")
    // It's in range if it's after start OR before end
    return now >= start || now <= end;
  }
}


export async function getAllFrames(){
  return await db.getAllFrames();
}

export async function getFrame(frame_id){
  return await db.getFrame(frame_id);
}

export async function updateFrame(frame_id, entry){
  return await db.updateFrame(frame_id, entry);
}

export async function deleteFrame(frame_id){
  return await db.deleteFrame(frame_id);
}

async function getItemsForFrame(frame_id){
  const frame = await getFrame(frame_id);
  if (!frame) {
    return [];
  }
  return await search.search(frame.collection_id, frame.search_str, false, false, frame.display_order);
}

