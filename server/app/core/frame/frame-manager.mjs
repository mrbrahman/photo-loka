import {EventEmitter} from 'events';
import * as db from './frame-db.mjs';
import * as search from '#search/search-engine';
import { scheduleJobsForFrame, removeJobsForFrame, scheduleResetJob, schedulePauseResumeJobs, removeResetJob, removePauseResumeJobs } from '#jobs/frame-jobs';

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
export const allFrames = {};

export async function loadAllFrames() {
  logger.info("Loading data for all frames...")

  let frames = await db.getAllFrames();

  for (let frame of frames){
    // initialize frame in case not set (during server startup)
    if (!(frame.frame_ip_addr in allFrames)){
      allFrames[frame.frame_ip_addr] = {
        autoPause: {paused: isInPauseWindow(frame.daily_pause_range), pauseEndTime: null},
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
      paused: isInPauseWindow(entry.daily_pause_range),
      pauseEndTime: null
    },
    manualPause: {
      paused: false,
      resumeAtSchedule: null
    }
  };

  scheduleJobsForFrame({ ...entry, frame_id });

  return frame_id;
}

export async function updateFrame(frame_id, entry){
  const oldFrame = await db.getFrameById(frame_id);
  await db.updateFrame(frame_id, entry);
  
  const oldIp = oldFrame.frame_ip_addr;
  const newIp = entry.frame_ip_addr;
  
  // Handle IP address change
  if (oldIp !== newIp) {
    allFrames[newIp] = allFrames[oldIp];
    delete allFrames[oldIp];
  }
  
  // Reload items if search criteria changed
  if (oldFrame.collection_id !== entry.collection_id || 
      oldFrame.search_str !== entry.search_str || 
      oldFrame.display_order !== entry.display_order) {
    await reloadItemsForFrame({ ...entry, frame_ip_addr: newIp });
  }
  
  // Update autoPause if daily_pause_range changed
  if (oldFrame.daily_pause_range !== entry.daily_pause_range) {
    allFrames[newIp].autoPause.paused = isInPauseWindow(entry.daily_pause_range);
  }
  
  // Reschedule reset job if changed
  if (oldFrame.reset_schedule !== entry.reset_schedule) {
    removeResetJob(frame_id);
    if (entry.reset_schedule) {
      scheduleResetJob(frame_id, entry.reset_schedule, { ...entry, frame_ip_addr: newIp });
    }
  }
  
  // Reschedule pause/resume jobs if changed
  if (oldFrame.daily_pause_range !== entry.daily_pause_range) {
    removePauseResumeJobs(frame_id);
    if (entry.daily_pause_range) {
      schedulePauseResumeJobs(frame_id, entry.daily_pause_range);
    }
  }
}

export async function deleteFrame(frame_id){
  const frame = await db.getFrameById(frame_id);
  removeJobsForFrame(frame_id);
  delete allFrames[frame.frame_ip_addr];
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

  // increment the index, wrap to start if end reached
  frame.curr_idx = (frame.curr_idx + 1) % frame.items.length;
  return frame.items[frame.curr_idx];
}

export function getPrevItem(frame_ip_addr){
  if (!allFrames[frame_ip_addr]) {
    throw new AppError(`No frame setup for IP address: ${frame_ip_addr}`, 'NotFoundError', 'NO_FRAME_SETUP', 404);
  }
  
  let frame = allFrames[frame_ip_addr];
  if (frame.manualPause.paused || frame.autoPause.paused) {
    throw new AppError('Frame is paused', 'FramePausedError', 'FRAME_PAUSED', 423, { pauseEndTime: frame.pauseEndTime });
  }

  // decrement the index, wrap to end if start reached
  // Note: if curr_idx is -1 (fresh reload), this will return the second-to-last item
  // instead of the last item, because (-1 - 1 + length) % length = length - 2. 
  // TODO: Handle if needed.
  frame.curr_idx = (frame.curr_idx - 1 + frame.items.length) % frame.items.length;
  return frame.items[frame.curr_idx];
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

export function isInPauseWindow(daily_pause_range) {
  return daily_pause_range ? inPauseWindow(daily_pause_range) : false;
}


async function getItemsForFrame(frame){
  return await search.search(frame.collection_id, frame.search_str, false, false, frame.display_order);
}

export async function setAutoPause(frame_id, paused) {
  const frame = await db.getFrameById(frame_id);
  if (!allFrames[frame.frame_ip_addr]) {
    throw new AppError(`No frame setup for IP address: ${frame.frame_ip_addr}`, 'NotFoundError', 'NO_FRAME_SETUP', 404);
  }
  
  let autoPauseState = allFrames[frame.frame_ip_addr].autoPause;
  let manualPauseState = allFrames[frame.frame_ip_addr].manualPause;
  
  if (paused) {
    autoPauseState.paused = true;
    autoPauseState.pauseEndTime = null;
    frameEvents.emit('frame-paused', { frame_ip_addr: frame.frame_ip_addr });
  }
  else {
    autoPauseState.paused = false;
    autoPauseState.pauseEndTime = null;

    // If auto-resuming and currently manually paused with resume at schedule, clear the manual pause as well
    if(manualPauseState.paused && manualPauseState.resumeAtSchedule) {
      manualPauseState.paused = false;
      manualPauseState.resumeAtSchedule = null;
    }

    // Emit frame-resumed only if the frame is not paused due to manual pause. 
    // If it's still manually paused, we consider it as still paused and won't emit frame-resumed.
    if(!manualPauseState.paused) {
      frameEvents.emit('frame-resumed', { frame_ip_addr: frame.frame_ip_addr });
    }

  }
  
  logger.info(`Frame ${frame.frame_ip_addr} autoPause set to ${paused}`);
}
