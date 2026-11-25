import { Router } from 'express';
import { config } from '../config.js';
import { claimConversation } from '../services/conversationService.js';

export const graderRouter = Router();

// Middleware: verifies x-grader-token matches GRADER_TOKEN
graderRouter.use('/__grader', (req, res, next) => {
  const token = req.header('x-grader-token');
  if (!token || token !== config.graderToken) {
    res.status(401).json({ error: 'Invalid or missing grader token' });
    return;
  }
  next();
});

/**
 * POST /__grader/claim { workspace, contact, agent }
 * Uses the exact same claimConversation service as the UI.
 */
graderRouter.post('/__grader/claim', async (req, res, next) => {
  try {
    const { workspace, contact, agent } = req.body ?? {};
    if (!workspace || !contact || !agent) {
      res.status(400).json({ error: 'workspace, contact, and agent are required' });
      return;
    }

    const result = await claimConversation(workspace, contact, agent);
    if (!result.success) {
      res.status(409).json({ error: 'claimed by another agent', assignee: result.assignee });
      return;
    }

    res.status(200).json({ ok: true, assignee: result.conversation.assignee });
  } catch (err) {
    next(err);
  }
});
