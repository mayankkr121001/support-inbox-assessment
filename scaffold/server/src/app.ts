import express, { type Express } from 'express';
import { apiRouter } from './routes/index.js';
import { webhooksRouter } from './routes/webhooks.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

/**
 * Builds and configures the Express application without starting a listener.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  // Mount webhooks before express.json() so signature verification uses the exact raw body.
  app.use(webhooksRouter);
  app.use(express.json());

  app.use(apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
