import { Router } from 'express';
import { pingDb } from '../db.js';

export const healthRouter = Router();

/**
 * Readiness endpoint: returns 200 only when the server can reach MongoDB.
 */
healthRouter.get('/healthz', async (_req, res) => {
  const dbOk = await pingDb();
  if (!dbOk) {
    res.status(503).json({ ok: false, db: 'disconnected' });
    return;
  }
  res.status(200).json({ ok: true, db: 'connected' });
});
