import { Router } from 'express';
import { healthRouter } from './health.js';
import { authRouter } from './auth.js';
import { conversationsRouter } from './conversations.js';
import { graderRouter } from './grader.js';

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use(graderRouter);
apiRouter.use(authRouter);
apiRouter.use(conversationsRouter);
