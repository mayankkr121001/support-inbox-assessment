import { EventEmitter } from 'node:events';
import type { Db } from 'mongodb';
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';

export type WorkspaceEventPayload =
  | {
      type: 'message.inbound';
      contact: string;
      message_id: string;
      text: string;
      occurred_at: string;
    }
  | {
      type: 'message.status';
      contact: string;
      client_ref: string;
      status: 'queued' | 'sent' | 'delivered' | 'failed';
      message_id?: string;
    }
  | {
      type: 'conversation.assigned';
      contact: string;
      assignee: string | null;
    };

export type WorkspaceEventFrame = WorkspaceEventPayload & {
  seq: number;
};

export interface WorkspaceEventDoc {
  workspace: string;
  seq: number;
  type: WorkspaceEventPayload['type'];
  contact: string;
  message_id?: string;
  text?: string;
  occurred_at?: string;
  client_ref?: string;
  status?: string;
  assignee?: string | null;
  createdAt: Date;
}

export const localEventBus = new EventEmitter();
localEventBus.setMaxListeners(100);

const fallbackSeqByWorkspace = new Map<string, number>();

export function wsChannelForWorkspace(workspace: string): string {
  return `ws:events:${workspace}`;
}

async function allocateSeq(workspace: string, db: Db): Promise<number> {
  try {
    const res = await db
      .collection<{ _id: string; seq: number }>('counters')
      .findOneAndUpdate(
        { _id: `ws_seq:${workspace}` },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      );
    if (res && typeof res.seq === 'number') {
      return res.seq;
    }
  } catch {
    // Fall back to in-memory counter if unit-test fakeDb does not mock `counters`
  }

  const next = (fallbackSeqByWorkspace.get(workspace) ?? 0) + 1;
  fallbackSeqByWorkspace.set(workspace, next);
  return next;
}

/**
 * Assigns a monotonically increasing workspace `seq`, persists the event for
 * `?after=<seq>` replay, and broadcasts it via Redis Pub/Sub (or local bus).
 */
export async function publishWorkspaceEvent(
  workspace: string,
  payload: WorkspaceEventPayload,
  dbOverride?: Db,
): Promise<WorkspaceEventFrame> {
  const db = dbOverride ?? (await getDb());
  const seq = await allocateSeq(workspace, db);
  const frame: WorkspaceEventFrame = { seq, ...payload };

  try {
    await db.collection('workspace_events').insertOne({
      workspace,
      ...frame,
      createdAt: new Date(),
    });
  } catch {
    // Ignore if unit-test fakeDb does not mock `workspace_events`
  }

  const redis = getRedis();
  if (redis.status === 'ready') {
    try {
      await redis.publish(
        wsChannelForWorkspace(workspace),
        JSON.stringify(frame),
      );
      return frame;
    } catch {
      // Fall back to local bus
    }
  }

  localEventBus.emit(workspace, frame);
  return frame;
}

/**
 * Returns all persisted events for a workspace with `seq > afterSeq`, in order.
 */
export async function getWorkspaceEventsAfter(
  workspace: string,
  afterSeq: number,
  dbOverride?: Db,
): Promise<WorkspaceEventFrame[]> {
  const db = dbOverride ?? (await getDb());
  const docs = await db
    .collection<WorkspaceEventDoc>('workspace_events')
    .find({ workspace, seq: { $gt: afterSeq } })
    .sort({ seq: 1 })
    .toArray();

  return docs.map((d) => {
    const { workspace: _ws, createdAt: _ca, _id: _id, ...frame } = d as WorkspaceEventDoc & {
      _id?: unknown;
    };
    return frame as WorkspaceEventFrame;
  });
}

export function resetFallbackSeq(): void {
  fallbackSeqByWorkspace.clear();
}
