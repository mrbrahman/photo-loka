import { Router } from 'express';
import { listAllJobs } from '#infra/scheduler';
import { listAllWatchers } from '#jobs/file-watcher-job';
import { getAllCollections } from '#collections/collection-manager';
import { getAllFrames } from '#frame/frame-manager';

const router = Router();

router.get('/jobs', async function(req, res, next) {
  try {
    const [collections, frames] = await Promise.all([
      getAllCollections(),
      getAllFrames()
    ]);

    // Active watchers (from chokidar)
    const activeWatchers = listAllWatchers();
    const activeWatcherPaths = new Set(activeWatchers.map(w => `${w.collection_id}:${w.intake_path}`));

    // Build watchers list from all immediate intakes (active + stopped)
    const watchers = [];
    for (const c of collections) {
      for (let i = 0; i < c.intake_configs.length; i++) {
        const intake = c.intake_configs[i];
        if (intake.method !== 'immediate') continue;
        const isActive = activeWatcherPaths.has(`${c.collection_id}:${intake.path}`);
        watchers.push({
          collection_id: c.collection_id,
          collection_name: c.collection_name || 'Unnamed',
          intake_path: intake.path,
          intake_index: i,
          status: isActive ? 'active' : 'stopped'
        });
      }
    }

    // All cron jobs from the scheduler
    const allJobs = listAllJobs();
    const activeJobNames = new Set(allJobs.map(j => j.name));

    // Build scheduled list from all scheduled intakes (active + stopped)
    const scheduled = [];
    for (const c of collections) {
      for (let i = 0; i < c.intake_configs.length; i++) {
        const intake = c.intake_configs[i];
        if (intake.method !== 'scheduled') continue;
        const jobName = `cron-c${c.collection_id}-i${i}`;
        const pattern = intake.config?.schedule || '0 1 * * *';
        scheduled.push({
          name: jobName,
          collection_id: c.collection_id,
          collection_name: c.collection_name || 'Unnamed',
          intake_path: intake.path,
          intake_index: i,
          pattern,
          status: activeJobNames.has(jobName) ? 'active' : 'stopped'
        });
      }
    }

    // Categorize remaining cron jobs (frame + system)
    const frameJobs = [];
    const systemJobs = [];

    for (const job of allJobs) {
      if (job.name.startsWith('cron-c')) {
        // Already handled above
        continue;
      } else if (job.name.startsWith('frame-')) {
        const match = job.name.match(/^frame-(reset|pause|resume)-(\d+)$/);
        if (match) {
          const type = match[1];
          const frameId = parseInt(match[2]);
          const frame = frames.find(f => f.frame_id === frameId);
          frameJobs.push({
            name: job.name,
            frame_id: frameId,
            frame_name: frame?.frame_name || 'Unknown',
            type,
            pattern: job.pattern
          });
        }
      } else {
        systemJobs.push({
          name: job.name,
          pattern: job.pattern
        });
      }
    }

    res.json({ watchers, scheduled, frame: frameJobs, system: systemJobs });
  } catch (error) {
    next(error);
  }
});

export default router;
