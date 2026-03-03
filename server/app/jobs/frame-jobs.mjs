import { addJob, deleteJob } from '#infra/scheduler';
import { getAllFrames, reloadItemsForFrame, setAutoPause } from '#frame/frame-manager';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

let cronJobs = new Set();

export async function scheduleFrameJobs() {
  const frames = await getAllFrames();
  for (const frame of frames) {
    scheduleJobsForFrame(frame);
  }
}

export function scheduleJobsForFrame(frame) {
  if (frame.reset_schedule) {
    scheduleResetJob(frame.frame_id, frame.reset_schedule, frame);
  }
  
  if (frame.daily_pause_range) {
    schedulePauseResumeJobs(frame.frame_id, frame.daily_pause_range);
  }
}

export function scheduleResetJob(frame_id, reset_schedule, frame) {
  const jobName = `frame-reset-${frame_id}`;
  cronJobs.add(jobName);
  addJob(jobName, reset_schedule, () => reloadItemsForFrame(frame));
  logger.info(`Created frame reset job ${jobName} with schedule ${reset_schedule}`);
}

export function schedulePauseResumeJobs(frame_id, daily_pause_range) {
  const [startTime, endTime] = daily_pause_range.split('-');
  const [startHour, startMin] = startTime.trim().split(':');
  const [endHour, endMin] = endTime.trim().split(':');
  
  const pauseJobName = `frame-pause-${frame_id}`;
  const resumeJobName = `frame-resume-${frame_id}`;
  
  const pauseCron = `${startMin} ${startHour} * * *`;
  const resumeCron = `${endMin} ${endHour} * * *`;
  
  cronJobs.add(pauseJobName);
  addJob(pauseJobName, pauseCron, () => setAutoPause(frame_id, true));
  logger.info(`Created frame pause job ${pauseJobName} with schedule ${pauseCron}`);
  
  cronJobs.add(resumeJobName);
  addJob(resumeJobName, resumeCron, () => setAutoPause(frame_id, false));
  logger.info(`Created frame resume job ${resumeJobName} with schedule ${resumeCron}`);
}

export function removeResetJob(frame_id) {
  const jobName = `frame-reset-${frame_id}`;
  if (cronJobs.has(jobName)) {
    deleteJob(jobName);
    cronJobs.delete(jobName);
    logger.info(`Removed job ${jobName}`);
  }
}

export function removePauseResumeJobs(frame_id) {
  const jobNames = [`frame-pause-${frame_id}`, `frame-resume-${frame_id}`];
  for (const jobName of jobNames) {
    if (cronJobs.has(jobName)) {
      deleteJob(jobName);
      cronJobs.delete(jobName);
      logger.info(`Removed job ${jobName}`);
    }
  }
}

export function removeJobsForFrame(frame_id) {
  const jobNames = [
    `frame-reset-${frame_id}`,
    `frame-pause-${frame_id}`,
    `frame-resume-${frame_id}`
  ];
  
  for (const jobName of jobNames) {
    if (cronJobs.has(jobName)) {
      deleteJob(jobName);
      cronJobs.delete(jobName);
      logger.info(`Removed job ${jobName}`);
    }
  }
}

export function stopFrameJobs() {
  for (const jobName of cronJobs) {
    deleteJob(jobName);
  }
  cronJobs.clear();
}
