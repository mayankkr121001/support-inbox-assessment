import { Router } from 'express';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';
import {
  claimConversation,
  type ConversationDoc,
  type MessageDoc,
} from '../services/conversationService.js';
import { resetFallbackSeq } from '../services/eventService.js';
import {
  isKnownWorkspace,
  queueReply,
  resetRateLimitState,
} from '../services/outboundService.js';

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

/**
 * POST /__grader/reply { workspace, contact, text, client_ref }
 * Uses the exact same queueReply service as the UI.
 */
graderRouter.post('/__grader/reply', async (req, res, next) => {
  try {
    const { workspace, contact, text, client_ref } = req.body ?? {};
    if (
      typeof workspace !== 'string' ||
      !workspace ||
      typeof contact !== 'string' ||
      !contact ||
      typeof text !== 'string' ||
      !text ||
      typeof client_ref !== 'string' ||
      !client_ref
    ) {
      res.status(400).json({
        error: 'workspace, contact, text, and client_ref are required',
      });
      return;
    }

    if (!isKnownWorkspace(workspace)) {
      res.status(404).json({ error: 'Unknown workspace' });
      return;
    }

    const result = await queueReply({
      workspace,
      contact,
      text,
      clientRef: client_ref,
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
});

/**
 * POST /__grader/reset
 * Deletes all application data in MongoDB and Redis (rate limits/counters).
 */
graderRouter.post('/__grader/reset', async (_req, res, next) => {
  try {
    const db = await getDb();
    await Promise.all([
      db.collection('conversations').deleteMany({}),
      db.collection('messages').deleteMany({}),
      db.collection('webhook_events').deleteMany({}),
      db.collection('workspace_events').deleteMany({}),
      db.collection('counters').deleteMany({}),
    ]);

    resetRateLimitState();
    resetFallbackSeq();

    const redis = getRedis();
    if (redis.status === 'ready') {
      try {
        const keys = await redis.keys('pigeon:*');
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } catch {
        // Ignore Redis cleanup failure
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /__grader/snapshot
 * Returns the exact state shape expected by harness/check.js.
 */
graderRouter.get('/__grader/snapshot', async (_req, res, next) => {
  try {
    const db = await getDb();
    const [conversations, inboundMessages, outboundMessages] = await Promise.all([
      db.collection<ConversationDoc>('conversations').find({}).toArray(),
      db
        .collection<MessageDoc>('messages')
        .find({ direction: 'inbound' })
        .sort({ occurredAt: 1, messageId: 1 })
        .toArray(),
      db
        .collection<MessageDoc>('messages')
        .find({ direction: 'outbound' })
        .toArray(),
    ]);

    const workspaces: Record<
      string,
      {
        contacts: Record<string, { inbound: string[]; assignee: string | null }>;
        outbound: Record<string, string>;
      }
    > = {};

    for (const ws of Object.keys(config.pigeon.apiKeys)) {
      workspaces[ws] = { contacts: {}, outbound: {} };
    }

    const ensureContact = (ws: string, contact: string) => {
      if (!workspaces[ws]) {
        workspaces[ws] = { contacts: {}, outbound: {} };
      }
      if (!workspaces[ws].contacts[contact]) {
        workspaces[ws].contacts[contact] = { inbound: [], assignee: null };
      }
      return workspaces[ws].contacts[contact];
    };

    for (const conv of conversations) {
      const entry = ensureContact(conv.workspace, conv.contact);
      entry.assignee = conv.assignee ?? null;
    }

    for (const msg of inboundMessages) {
      if (!msg.messageId) continue;
      const entry = ensureContact(msg.workspace, msg.contact);
      entry.inbound.push(msg.messageId);
    }

    for (const msg of outboundMessages) {
      if (!msg.clientRef || !msg.status) continue;
      if (!workspaces[msg.workspace]) {
        workspaces[msg.workspace] = { contacts: {}, outbound: {} };
      }
      workspaces[msg.workspace].outbound[msg.clientRef] = msg.status;
    }

    res.status(200).json({ workspaces });
  } catch (err) {
    next(err);
  }
});
