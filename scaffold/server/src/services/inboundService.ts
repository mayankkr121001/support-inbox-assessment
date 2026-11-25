import { MongoServerError } from 'mongodb';
import { getDb } from '../db.js';

export interface InboundMessageInput {
  eventId: string;
  workspace: string;
  contact: string;
  messageId: string;
  text: string;
  occurredAt: Date;
}

function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/**
 * Stores an inbound customer message, ensures its conversation exists,
 * and prevents duplicates by (workspace, messageId) and eventId.
 */
export async function storeInboundMessage(
  input: InboundMessageInput,
): Promise<{ duplicate: boolean }> {
  const db = await getDb();
  const now = new Date();

  let duplicate = false;

  try {
    await db.collection('messages').insertOne({
      workspace: input.workspace,
      contact: input.contact,
      direction: 'inbound',
      messageId: input.messageId,
      text: input.text,
      occurredAt: input.occurredAt,
      createdAt: now,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
    duplicate = true;
  }

  // Ensure conversation exists even on retry after a partial crash,
  // and keep lastActivityAt at the newest occurredAt seen so far.
  try {
    await db.collection('conversations').updateOne(
      { workspace: input.workspace, contact: input.contact },
      {
        $setOnInsert: {
          workspace: input.workspace,
          contact: input.contact,
          assignee: null,
          status: 'open',
          createdAt: now,
        },
        $max: { lastActivityAt: input.occurredAt },
      },
      { upsert: true },
    );
  } catch (err) {
    // Two concurrent first-messages for the same contact can race on upsert;
    // retry the update without upsert since the document now exists.
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
    await db.collection('conversations').updateOne(
      { workspace: input.workspace, contact: input.contact },
      { $max: { lastActivityAt: input.occurredAt } },
    );
  }

  try {
    await db.collection('webhook_events').insertOne({
      eventId: input.eventId,
      type: 'message.inbound',
      workspace: input.workspace,
      receivedAt: now,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
    duplicate = true;
  }

  return { duplicate };
}
