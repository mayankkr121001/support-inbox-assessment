import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

/**
 * GET /api/me
 * Returns current authenticated user and workspaces, or 401 without session.
 */
authRouter.get('/api/me', requireAuth, (req, res) => {
  res.status(200).json({
    sub: req.user!.sub,
    workspaces: req.user!.workspaces,
    name: req.user!.name,
    email: req.user!.email,
  });
});
