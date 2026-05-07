import * as path from 'path';

import express from 'express';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import { createLogger } from './app/utils/logger.mjs';
import { AppError } from './app/utils/app-error.mjs';

import * as s from './app/services.mjs';
import { authenticateToken, requireAdmin } from './middleware/authn-middleware.mjs';

// Route imports
import authnRoutes from './routes/authn.routes.mjs';
import searchRoutes from './routes/search.routes.mjs';
import mediaRoutes from './routes/media.routes.mjs';
import collectionsRoutes from './routes/collections.routes.mjs';
import { adminCollectionsRouter } from './routes/collections.routes.mjs';
import indexerRoutes from './routes/indexer.routes.mjs';
import itemsRoutes from './routes/items.routes.mjs';
import albumsRoutes from './routes/albums.routes.mjs';
import geoRoutes from './routes/geo.routes.mjs';
import facesRoutes from './routes/faces.routes.mjs';
import configRoutes from './routes/config.routes.mjs';
import watchersRoutes from './routes/watchers.routes.mjs';
import jobsRoutes from './routes/jobs.routes.mjs';
import adminJobsRoutes from './routes/admin-jobs.routes.mjs';
import adminUsersRoutes from './routes/admin-users.routes.mjs';
import backupRoutes from './routes/backup.routes.mjs';
import { frameRouter, adminFrameRouter, frameSSEClients } from './routes/frames.routes.mjs';
import dashboardRoutes from './routes/dashboard.routes.mjs';

const logger = createLogger(import.meta.url);

const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(import.meta.dirname, '../web')));

morgan.token('query', (req) => JSON.stringify(req.query));
morgan.token('body', (req) => JSON.stringify(req.body));

const morganMiddleware = morgan(
  ':method :url :status :response-time ms - q::query b::body',
  {
    skip: (req) => 
         req.url.includes('/getThumbnail')
      || req.url.includes('getFaceThumbnail'),
      // || req.url.includes('/getImage')
      // || req.url.includes('/getVideo')
      // || req.url.includes('/getNext')
      // || req.url.includes('/getPrev'),
    stream: {
        write: (message) => logger.info(message.trim()),
    },
  }
);

app.use(morganMiddleware);

// *****************************************
// Mount routes
// *****************************************

// Authentication routes (no auth required)
app.use('/api/authn', authnRoutes);

// Frame routes (no auth required)
app.use('/frame', frameRouter);

// API routes (auth required)
app.use('/api', authenticateToken, searchRoutes);
app.use('/api', authenticateToken, mediaRoutes);
app.use('/api', authenticateToken, collectionsRoutes);
app.use('/api', authenticateToken, itemsRoutes);
app.use('/api', authenticateToken, albumsRoutes);
app.use('/api', authenticateToken, geoRoutes);
app.use('/api', authenticateToken, facesRoutes);
app.use('/api', authenticateToken, backupRoutes);

// Admin routes (auth + admin role required)
app.use('/api/admin', authenticateToken, requireAdmin, adminFrameRouter);
app.use('/api/admin', authenticateToken, requireAdmin, adminCollectionsRouter);
app.use('/api/admin', authenticateToken, requireAdmin, indexerRoutes);
app.use('/api/admin', authenticateToken, requireAdmin, configRoutes);
app.use('/api/admin', authenticateToken, requireAdmin, dashboardRoutes);
app.use('/api/admin', authenticateToken, requireAdmin, watchersRoutes);
app.use('/api/admin', authenticateToken, requireAdmin, jobsRoutes);
app.use('/api/admin', authenticateToken, requireAdmin, adminJobsRoutes);
app.use('/api/admin', authenticateToken, requireAdmin, adminUsersRoutes);

// Utility endpoints
app.get('/speed-test', (req, res) => {
  // Send 1MB of random data
  const buffer = Buffer.alloc(1024 * 1024);
  res.set('Content-Type', 'application/octet-stream');
  res.send(buffer);
});

app.get('/ping', (req, res) => {
  res.status(204).end(); // No content, just a header response
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Error:', err);
  if (err instanceof AppError) {
    res.status(err.statusCode || 500).json({
      error: { code: err.code, message: err.message, info: err.info }
    });
  } else {
    res.status(500).json({
      error: {
        code: 'UNKNOWN_ERROR',
        message: err.message || 'An unexpected error occurred'
      }
    });
  }
});


// *****************************************
// start server
// *****************************************

process.on('SIGUSR2', function(){
  logger.info('***** Nodemon restart signal received **** ');
  handleServerShutdown();
});

process.on('SIGINT', function(){
  logger.info('***** Interrupt signal received **** ');
  handleServerShutdown();
});

process.on('SIGTERM', function(){
  logger.info('***** Terminate signal received **** ');
  handleServerShutdown();
});

const handleServerShutdown = async function(){
  // Close all SSE connections
  logger.info(`Closing ${frameSSEClients.size} SSE connection(s)...`);
  for (const [ip, client] of frameSSEClients.entries()) {
    client.end();
  }
  frameSSEClients.clear();
  
  await s.shutdown.shutdownCleanup();

  server.close(()=>{
    logger.info('app shutdown. Ending process... ');
    process.exit(0);
  });
}

let server = app.listen(9000, async ()=>{
  logger.info("app started and listening in port 9000!");
  // Perform startup activities
  await s.startup.startUpActivities();
});
