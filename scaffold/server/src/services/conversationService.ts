import type { Db } from 'mongodb';
import { MongoServerError } from 'mongodb';
import { getDb } from '../db.js';

export interface ConversationDoc {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed';
  lastActivityAt: Date;
  createdAt: Date;
  closedAt?: Date;
  reopenedAt?: Date;
}

export interface MessageDoc {
  workspace: string;
  contact: string;
  direction: 'inbound' | 'outbound';
  messageId?: string;
  clientRef?: string;
  text: string;
  status?: string;
  occurredAt?: Date;
  createdAt: Date;
}

export interface ListConversationsOptions {
  workspace: string;
  limit?: number;
  before?: Date;
}

function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/**
 * Lists conversations for a workspace, sorted newest activity first.
 */
export async function listConversations(
  options: ListConversationsOptions,
  dbOverride?: Db,
): Promise<ConversationDoc[]> {
  const db = dbOverride ?? (await getDb());
  const limit = Math.max(1, Math.min(options.limit ?? 50, 100));

  const filter: Record<string, unknown> = { workspace: options.workspace };
  if (options.before) {
    filter.lastActivityAt = { $lt: options.before };
  }

  const docs = await db
    .collection<ConversationDoc>('conversations')
    .find(filter)
    .sort({ lastActivityAt: -1 })
    .limit(limit)
    .toArray();

  return docs;
}

/**
 * Gets conversation details by contact within a workspace.
 */
export async function getConversation(
  workspace: string,
  contact: string,
  dbOverride?: Db,
): Promise<ConversationDoc | null> {
  const db = dbOverride ?? (await getDb());
  return db
    .collection<ConversationDoc>('conversations')
    .findOne({ workspace, contact });
}

/**
 * Gets message history for a contact within a workspace, oldest first.
 */
export async function getConversationMessages(
  workspace: string,
  contact: string,
  dbOverride?: Db,
): Promise<MessageDoc[]> {
  const db = dbOverride ?? (await getDb());
  const docs = await db
    .collection<MessageDoc>('messages')
    .find({ workspace, contact })
    .sort({ occurredAt: 1, messageId: 1, createdAt: 1 })
    .toArray();

  return docs;
}

export type ClaimResult =
  | { success: true; conversation: ConversationDoc }
  | { success: false; status: 409; assignee: string };

/**
 * Atomically claims a conversation for an agent.
 * If the conversation does not exist yet, creates it.
 * If held by another agent, returns 409 conflict with the current assignee.
 * If held by the same agent or unassigned, assigns to this agent and returns 200.
 */
export async function claimConversation(
  workspace: string,
  contact: string,
  agent: string,
  dbOverride?: Db,
): Promise<ClaimResult> {
  const db = dbOverride ?? (await getDb());
  const now = new Date();

  // 1. Ensure conversation exists
  try {
    await db.collection<ConversationDoc>('conversations').updateOne(
      { workspace, contact },
      {
        $setOnInsert: {
          workspace,
          contact,
          assignee: null,
          status: 'open',
          createdAt: now,
          lastActivityAt: now,
        },
      },
      { upsert: true },
    );
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
  }

  // 2. Atomic claim if unassigned or already held by this agent
  const result = await db
    .collection<ConversationDoc>('conversations')
    .findOneAndUpdate(
      {
        workspace,
        contact,
        $or: [{ assignee: null }, { assignee: agent }],
      },
      {
        $set: { assignee: agent },
      },
      { returnDocument: 'after' },
    );

  if (result) {
    return { success: true, conversation: result };
  }

  // Claim failed because someone else holds it
  const current = await db
    .collection<ConversationDoc>('conversations')
    .findOne({ workspace, contact });

  return {
    success: false,
    status: 409,
    assignee: current?.assignee ?? 'unknown',
  };
}

/**
 * Closes a conversation.
 */
export async function closeConversation(
  workspace: string,
  contact: string,
  dbOverride?: Db,
): Promise<ConversationDoc | null> {
  const db = dbOverride ?? (await getDb());
  const now = new Date();

  const result = await db
    .collection<ConversationDoc>('conversations')
    .findOneAndUpdate(
      { workspace, contact },
      { $set: { status: 'closed', closedAt: now } },
      { returnDocument: 'after' },
    );

  return result;
}

/**
 * Reopens a conversation.
 */
export async function reopenConversation(
  workspace: string,
  contact: string,
  dbOverride?: Db,
): Promise<ConversationDoc | null> {
  const db = dbOverride ?? (await getDb());
  const now = new Date();

  const result = await db
    .collection<ConversationDoc>('conversations')
    .findOneAndUpdate(
      { workspace, contact },
      { $set: { status: 'open', reopenedAt: now } },
      { returnDocument: 'after' },
    );

  return result;
}
