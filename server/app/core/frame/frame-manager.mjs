import {EventEmitter} from 'events';
import * as db from './frame-db.mjs';
import * as search from '#search/search-engine';

import { createLogger } from '#utils/logger';
import { AppError } from '#utils/app-error';

const logger = createLogger(import.meta.url);

class EmitterClass extends EventEmitter {};
export const frameEvents = new EmitterClass();

// This is an object storing frame states with the frame IP address as the key. Each entry has the following structure:
// frame_ip_addr: {
//   items: [], // the list of items to display for this frame
//   curr_idx: <num>, // the current index in the items list
//   autoPause: { paused: false, pauseEndTime: null }, // auto-pause state
//   manualPause: { paused: false, resumeAtSchedule: null } // manual pause state
// }
const allFrames = {};

export async function loadAllFrames() {
  logger.info("Loading data for all frames...")

  let frames = await db.getAllFrames();

  for (let frame of frames){
    // initialize frame in case not set (during server startup)
    if (!(frame.frame_ip_addr in allFrames)){
      allFrames[frame.frame_ip_addr] = {
        autoPause: {paused: false, pauseEndTime: null},  // TODO
        manualPause: {paused: false, resumeAtSchedule: null}
      }
    }
    await reloadItemsForFrame(frame);
  }

  logger.info(`Data for ${frames.length} frame(s) loaded`);
}

// this function gets the data of the frame setup from the db
// as well as the current state of the frame (current index, whether it's paused, etc)

export async function getAllFrames(){
  let frames = await db.getAllFrames();
  return frames.map(frameData=>{
    // current state
    let f = allFrames[frameData.frame_ip_addr];
    
    return {
      ...frameData,
      numItems: f['items'].length, 
      currIdx: f['curr_idx'],
      autoPause: f['autoPause'],
      manualPause: f['manualPause']
    }
  })
}

export async function createNewFrame(entry){
  let frame_id = await db.createNewFrame(entry);
  
  let items = await getItemsForFrame(entry);

  allFrames[entry.frame_ip_addr] = {
    items: items,
    curr_idx: -1,
    autoPause: {
      paused: false,     // TODO: Check based on daily_pause_range
      pauseEndTime: null
    },
    manualPause: {
      paused: false,
      resumeAtSchedule: null
    }
  };

  return frame_id;
}

export async function updateFrame(frame_id, entry){
  return await db.updateFrame(frame_id, entry);
  // TODO: reload items for the frame if collection_id, search_str, or display_order changed
}

export async function deleteFrame(frame_id){
  return await db.deleteFrame(frame_id);
}

export async function pauseFrame(frame_id, resumeAtSchedule) {
  const frame = await db.getFrameById(frame_id);
  if (!allFrames[frame.frame_ip_addr]) {
    throw new AppError(`No frame setup for IP address: ${frame.frame_ip_addr}`, 'NotFoundError', 'NO_FRAME_SETUP', 404);
  }
  
  const frameState = allFrames[frame.frame_ip_addr];
  
  frameState.manualPause.paused = true;
  frameState.manualPause.resumeAtSchedule = resumeAtSchedule ?? false;
  
  // Emit event for SSE notification
  frameEvents.emit('frame-paused', { frame_ip_addr: frame.frame_ip_addr });
  
  logger.info(`Frame ${frame.frame_ip_addr} paused manually. Resume At schedule: ${frameState.manualPause.resumeAtSchedule}`);
}

export async function resumeFrame(frame_id) {
  const frame = await db.getFrameById(frame_id);
  if (!allFrames[frame.frame_ip_addr]) {
    throw new AppError(`No frame setup for IP address: ${frame.frame_ip_addr}`, 'NotFoundError', 'NO_FRAME_SETUP', 404);
  }
  
  const frameState = allFrames[frame.frame_ip_addr];

  frameState.manualPause.paused = false;
  frameState.manualPause.resumeAtSchedule = null;
  
  // Emit event for SSE notification
  frameEvents.emit('frame-resumed', { frame_ip_addr: frame.frame_ip_addr });
  
  logger.info(`Frame ${frame.frame_ip_addr} resumed`);
}

export async function reloadItemsForFrame(frame){
  let items = await getItemsForFrame(frame);

  allFrames[frame.frame_ip_addr].items = items;
  allFrames[frame.frame_ip_addr].curr_idx = -1;
  
  logger.info(`Data for frame ${frame.frame_ip_addr} loaded with ${items.length} items`);
}


export function getNextItem(frame_ip_addr){
  if (!allFrames[frame_ip_addr]) {
    throw new AppError(`No frame setup for IP address: ${frame_ip_addr}`, 'NotFoundError', 'NO_FRAME_SETUP', 404);
  }

  let frame = allFrames[frame_ip_addr];
  if (frame.manualPause.paused || frame.autoPause.paused) {
    throw new AppError('Frame is paused', 'FramePausedError', 'FRAME_PAUSED', 423)
  }

  // increment the index and return the item
  return frame.items[++frame.curr_idx];
}

export function getPrevItem(frame_ip_addr){
  if (!allFrames[frame_ip_addr]) {
    throw new AppError(`No frame setup for IP address: ${frame_ip_addr}`, 'NotFoundError', 'NO_FRAME_SETUP', 404);
  }
  
  let frame = allFrames[frame_ip_addr];
  if (frame.manualPause.paused || frame.autoPause.paused) {
    throw new AppError('Frame is paused', 'FramePausedError', 'FRAME_PAUSED', 423, { pauseEndTime: frame.pauseEndTime });
  }

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


async function getItemsForFrame(frame){
  return await search.search(frame.collection_id, frame.search_str, false, false, frame.display_order);
}
