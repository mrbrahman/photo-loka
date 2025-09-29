import cron from 'node-cron';

const activeJobs = new Map();

export function addJob(name, cronPattern, handler) {
  if (activeJobs.has(name)) {
    console.warn(`Job ${name} is already active`);
    return;
  }
  
  const job = cron.schedule(cronPattern, async () => {
    try {
      await handler();
    } catch (error) {
      console.error(`Error in job ${name}:`, error);
    }
  });
  
  activeJobs.set(name, job);
  console.log(`Job ${name} registered with pattern ${cronPattern}`);
}

export function deleteJob(name) {
  const job = activeJobs.get(name);
  if (job) {
    job.stop();
    job.destroy();
    activeJobs.delete(name);
    console.log(`Job ${name} unregistered`);
  }
}

export function deleteAllJobs() {
  activeJobs.forEach((job, name) => {
    job.stop();
    job.destroy();
    console.log(`Removed job: ${name}`);
  });
}

export function getJobStatus(name) {
  const job = activeJobs.get(name);
  return job ? { name, running: job.running } : null;
}
