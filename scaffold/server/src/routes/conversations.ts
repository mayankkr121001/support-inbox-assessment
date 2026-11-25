import { Router } from 'express';
import { requireAuth, requireWorkspaceAccess } from '../middleware/auth.js';
import {
  claimConversation,
  closeConversation,
  getConversation,
  getConversationMessages,
  listConversations,
  reopenConversation,
} from '../services/conversationService.js';
import { queueReply } from '../services/outboundService.js';

export const conversationsRouter = Router();

// Only protect /api/conversations routes
conversationsRouter.use('/api/conversations', requireAuth, requireWorkspaceAccess);

/**
 * GET /api/conversations?workspace=<id>&limit=<n>&before=<iso>
 * Lists conversations for a workspace, newest activity first.
 */
conversationsRouter.get('/api/conversations', async (req, res, next) => {
  try {
    const workspace = req.query.workspace as string;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const beforeStr = req.query.before as string | undefined;
    const before = beforeStr ? new Date(beforeStr) : undefined;

    const conversations = await listConversations({
      workspace,
      limit,
      before: before && !Number.isNaN(before.getTime()) ? before : undefined,
    });

    res.status(200).json({ conversations });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/conversations/:contact?workspace=<id>
 * Gets conversation details and message history (oldest first).
 */
conversationsRouter.get(
  '/api/conversations/:contact',
  async (req, res, next) => {
    try {
      const workspace = req.query.workspace as string;
      const contact = req.params.contact;

      const [conversation, messages] = await Promise.all([
        getConversation(workspace, contact),
        getConversationMessages(workspace, contact),
      ]);

      if (!conversation && messages.length === 0) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      res.status(200).json({ conversation, messages });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/conversations/:contact/claim?workspace=<id>
 * Claims a conversation for the authenticated agent.
 */
conversationsRouter.post(
  '/api/conversations/:contact/claim',
  async (req, res, next) => {
    try {
      const workspace = req.query.workspace as string;
      const contact = req.params.contact;
      const agent =
        (req.body && typeof req.body === 'object' && typeof req.body.agent === 'string'
          ? req.body.agent
          : undefined) || req.user!.sub;

      const result = await claimConversation(workspace, contact, agent);

      if (!result.success) {
        res.status(409).json({
          error: 'Conversation already claimed by another agent',
          assignee: result.assignee,
        });
        return;
      }

      res.status(200).json({ ok: true, conversation: result.conversation });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/conversations/:contact/close?workspace=<id>
 * Closes a conversation.
 */
conversationsRouter.post(
  '/api/conversations/:contact/close',
  async (req, res, next) => {
    try {
      const workspace = req.query.workspace as string;
      const contact = req.params.contact;

      const conversation = await closeConversation(workspace, contact);
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      res.status(200).json({ ok: true, conversation });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/conversations/:contact/replies?workspace=<id>
 * Queues an outbound reply to the contact and returns 202 once stored.
 */
conversationsRouter.post(
  '/api/conversations/:contact/replies',
  async (req, res, next) => {
    try {
      const workspace = req.query.workspace as string;
      const contact = req.params.contact;
      const text =
        req.body && typeof req.body === 'object' ? req.body.text : undefined;
      const clientRef =
        req.body &&
        typeof req.body === 'object' &&
        typeof req.body.client_ref === 'string' &&
        req.body.client_ref
          ? req.body.client_ref
          : undefined;

      if (typeof text !== 'string' || !text.trim()) {
        res.status(400).json({ error: 'text is required' });
        return;
      }

      const result = await queueReply({
        workspace,
        contact,
        text,
        clientRef,
      });

      res.status(202).json({
        ok: true,
        client_ref: result.clientRef,
        duplicate: result.duplicate,
        status: result.status,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/conversations/:contact/reopen?workspace=<id>
 * Reopens a closed conversation.
 */
conversationsRouter.post(
  '/api/conversations/:contact/reopen',
  async (req, res, next) => {
    try {
      const workspace = req.query.workspace as string;
      const contact = req.params.contact;

      const conversation = await reopenConversation(workspace, contact);
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      res.status(200).json({ ok: true, conversation });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/conversations/:contact/replies?workspace=<id>
 * Queues an outbound reply to the contact and returns 202 once stored.
 */
conversationsRouter.post(
  '/api/conversations/:contact/replies',
  async (req, res, next) => {
    try {
      const workspace = req.query.workspace as string;
      const contact = req.params.contact;
      const text =
        req.body && typeof req.body === 'object' ? req.body.text : undefined;
      const clientRef =
        req.body &&
        typeof req.body === 'object' &&
        typeof req.body.client_ref === 'string' &&
        req.body.client_ref
          ? req.body.client_ref
          : undefined;

      if (typeof text !== 'string' || !text.trim()) {
        res.status(400).json({ error: 'text is required' });
        return;
      }

      const result = await queueReply({
        workspace,
        contact,
        text,
        clientRef,
      });

      res.status(202).json({
        ok: true,
        client_ref: result.clientRef,
        duplicate: result.duplicate,
        status: result.status,
      });
    } catch (err) {
      next(err);
    }
  },
);
