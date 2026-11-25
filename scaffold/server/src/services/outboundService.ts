import { randomUUID } from 'node:crypto';
import { MongoServerError, type Db } from 'mongodb';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';
import { publishWorkspaceEvent } from './eventService.js';

export type OutboundStatus = 'queued' | 'sent' | 'delivered' | 'failed';

const STATUS_RANK: Record<OutboundStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  failed: 2,
};

export interface QueueReplyInput {
  workspace: string;
  contact: string;
  text: string;
  clientRef?: string;
}

export interface QueueReplyResult {
  clientRef: string;
  duplicate: boolean;
  status: OutboundStatus;
}

export interface StatusWebhookInput {
  eventId: string;
  workspace: string;
  clientRef: string;
  messageId?: string;
  status: 'sent' | 'delivered' | 'failed';
  occurredAt: Date;
}

export interface OutboundMessageRecord {
  workspace: string;
  contact: string;
  direction: 'outbound';
  text: string;
  clientRef: string;
  status: OutboundStatus;
  acceptedByProvider: boolean;
  messageId?: string;
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil?: Date | null;
  lastError?: string;
  occurredAt: Date;
  createdAt: Date;
}

function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

export function isKnownWorkspace(workspace: string): boolean {
  return Object.hasOwn(config.pigeon.apiKeys, workspace);
}

/**
 * Safely stores an outbound reply in MongoDB as `queued` and ensures the
 * conversation exists. Duplicate (workspace, clientRef) requests are idempotent.
 */
export async function queueReply(
  input: QueueReplyInput,
  dbOverride?: Db,
): Promise<QueueReplyResult> {
  const db = dbOverride ?? (await getDb());
  const now = new Date();
  const clientRef = input.clientRef || `ref_${randomUUID()}`;

  let duplicate = false;
  let currentStatus: OutboundStatus = 'queued';

  try {
    await db.collection('messages').insertOne({
      workspace: input.workspace,
      contact: input.contact,
      direction: 'outbound',
      text: input.text,
      clientRef,
      status: 'queued',
      acceptedByProvider: false,
      attempts: 0,
      nextAttemptAt: now,
      occurredAt: now,
      createdAt: now,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
    duplicate = true;
    const existing = await db
      .collection<OutboundMessageRecord>('messages')
      .findOne({ workspace: input.workspace, clientRef });
    if (existing?.status) {
      currentStatus = existing.status;
    }
  }

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
        $max: { lastActivityAt: now },
      },
      { upsert: true },
    );
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
    await db.collection('conversations').updateOne(
      { workspace: input.workspace, contact: input.contact },
      { $max: { lastActivityAt: now } },
    );
  }

  return { clientRef, duplicate, status: currentStatus };
}

/**
 * Updates an outbound message's status from a Pigeon `message.status` webhook,
 * enforcing monotonic status precedence so out-of-order events never downgrade
 * `delivered`/`failed` back to `sent`.
 */
export async function handleMessageStatus(
  input: StatusWebhookInput,
  dbOverride?: Db,
): Promise<{ found: boolean; updated: boolean }> {
  const db = dbOverride ?? (await getDb());
  const now = new Date();

  const existing = await db
    .collection<OutboundMessageRecord>('messages')
    .findOne({
      workspace: input.workspace,
      clientRef: input.clientRef,
      direction: 'outbound',
    });

  if (!existing) {
    // Unknown client_ref: per PIGEON.md, return 2xx and ignore
    return { found: false, updated: false };
  }

  const currentRank = STATUS_RANK[existing.status] ?? 0;
  const nextRank = STATUS_RANK[input.status];
  let updated = false;

  if (nextRank > currentRank) {
    const allowedPreviousStatuses = (
      Object.keys(STATUS_RANK) as OutboundStatus[]
    ).filter((s) => STATUS_RANK[s] < nextRank);

    const setFields: Record<string, unknown> = {
      status: input.status,
      acceptedByProvider: true,
      statusUpdatedAt: now,
    };
    if (input.messageId) {
      setFields.messageId = input.messageId;
    }

    const res = await db.collection('messages').updateOne(
      {
        workspace: input.workspace,
        clientRef: input.clientRef,
        status: { $in: allowedPreviousStatuses },
      },
      { $set: setFields },
    );
    updated = res.modifiedCount > 0;
  } else if (input.messageId && !existing.messageId) {
    await db.collection('messages').updateOne(
      { workspace: input.workspace, clientRef: input.clientRef },
      { $set: { messageId: input.messageId, acceptedByProvider: true } },
    );
  }

  try {
    await db.collection('webhook_events').insertOne({
      eventId: input.eventId,
      type: 'message.status',
      workspace: input.workspace,
      receivedAt: now,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) {
      throw err;
    }
  }

  if (updated) {
    await publishWorkspaceEvent(
      input.workspace,
      {
        type: 'message.status',
        contact: existing.contact,
        client_ref: input.clientRef,
        status: input.status,
        message_id: input.messageId ?? existing.messageId,
      },
      db,
    );
  }

  return { found: true, updated };
}

// --- Per-workspace rate limiting & Retry-After cool-off ---

interface MemoryBucket {
  tokens: number;
  updatedAt: number;
  coolOffUntil: number;
}

const memoryBuckets = new Map<string, MemoryBucket>();

const RATE_LIMIT_CAPACITY = 8;
const RATE_LIMIT_REFILL_PER_SEC = 4;

// Atomic Redis Lua script: checks cool-off timestamp and takes 1 token from an
// 8-token / 4-per-sec bucket. Returns [1, 0] if allowed, or [0, waitMs] if not.
const TAKE_TOKEN_LUA = `
local bucketKey = KEYS[1]
local coolKey = KEYS[2]
local nowMs = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refillPerSec = tonumber(ARGV[3])

local coolUntil = tonumber(redis.call('GET', coolKey) or '0')
if coolUntil > nowMs then
  return {0, coolUntil - nowMs}
end

local data = redis.call('HMGET', bucketKey, 'tokens', 'at')
local tokens = tonumber(data[1])
local lastAt = tonumber(data[2])
if tokens == nil or lastAt == nil then
  tokens = capacity
  lastAt = nowMs
else
  local elapsed = math.max(0, nowMs - lastAt) / 1000.0
  tokens = math.min(capacity, tokens + elapsed * refillPerSec)
  lastAt = nowMs
end

if tokens < 1 then
  redis.call('HMSET', bucketKey, 'tokens', tokens, 'at', lastAt)
  redis.call('PEXPIRE', bucketKey, 60000)
  local waitMs = math.ceil(((1 - tokens) / refillPerSec) * 1000)
  return {0, math.max(50, waitMs)}
end

tokens = tokens - 1
redis.call('HMSET', bucketKey, 'tokens', tokens, 'at', lastAt)
redis.call('PEXPIRE', bucketKey, 60000)
return {1, 0}
`;

export async function tryAcquireSendSlot(
  workspace: string,
  nowMs = Date.now(),
): Promise<{ allowed: boolean; waitMs: number }> {
  const redis = getRedis();
  if (redis.status === 'ready') {
    try {
      const res = (await redis.eval(
        TAKE_TOKEN_LUA,
        2,
        `pigeon:bucket:${workspace}`,
        `pigeon:cooloff:${workspace}`,
        String(nowMs),
        String(RATE_LIMIT_CAPACITY),
        String(RATE_LIMIT_REFILL_PER_SEC),
      )) as [number, number];
      return { allowed: res[0] === 1, waitMs: res[1] };
    } catch {
      // Fall back to in-memory limiter if Redis command fails
    }
  }

  let bucket = memoryBuckets.get(workspace);
  if (!bucket) {
    bucket = {
      tokens: RATE_LIMIT_CAPACITY,
      updatedAt: nowMs,
      coolOffUntil: 0,
    };
    memoryBuckets.set(workspace, bucket);
  }

  if (bucket.coolOffUntil > nowMs) {
    return { allowed: false, waitMs: bucket.coolOffUntil - nowMs };
  }

  const elapsedSec = Math.max(0, nowMs - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(
    RATE_LIMIT_CAPACITY,
    bucket.tokens + elapsedSec * RATE_LIMIT_REFILL_PER_SEC,
  );
  bucket.updatedAt = nowMs;

  if (bucket.tokens < 1) {
    const waitMs = Math.ceil(
      ((1 - bucket.tokens) / RATE_LIMIT_REFILL_PER_SEC) * 1000,
    );
    return { allowed: false, waitMs: Math.max(50, waitMs) };
  }

  bucket.tokens -= 1;
  return { allowed: true, waitMs: 0 };
}

export async function setWorkspaceCoolOff(
  workspace: string,
  retryAfterSeconds: number,
  nowMs = Date.now(),
): Promise<void> {
  // Add a small 150ms buffer so clock jitter never fires inside Retry-After
  const waitMs = Math.max(1000, Math.ceil(retryAfterSeconds * 1000) + 150);
  const coolOffUntil = nowMs + waitMs;

  const bucket = memoryBuckets.get(workspace) ?? {
    tokens: 0,
    updatedAt: nowMs,
    coolOffUntil: 0,
  };
  bucket.tokens = 0;
  bucket.updatedAt = nowMs;
  bucket.coolOffUntil = Math.max(bucket.coolOffUntil, coolOffUntil);
  memoryBuckets.set(workspace, bucket);

  const redis = getRedis();
  if (redis.status === 'ready') {
    try {
      await redis.set(
        `pigeon:cooloff:${workspace}`,
        String(coolOffUntil),
        'PX',
        waitMs,
      );
    } catch {
      // Memory fallback already recorded cool-off
    }
  }
}

export function resetRateLimitState(): void {
  memoryBuckets.clear();
}

// --- Outbound delivery & retry worker ---

export interface OutboundDeps {
  db?: Db;
  fetchImpl?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
}

function backoffDelayMs(attempts: number): number {
  return Math.min(10000, 500 * Math.pow(2, Math.min(attempts, 5)));
}

/**
 * Claims one due outbound message via an atomic MongoDB lease and attempts
 * delivery to Pigeon. Returns true if a message was processed.
 */
export async function processNextOutboundMessage(
  deps: OutboundDeps = {},
): Promise<boolean> {
  const db = deps.db ?? (await getDb());
  const fetchFn = deps.fetchImpl ?? fetch;
  const nowMs = (deps.now ?? Date.now)();
  const now = new Date(nowMs);
  const leaseUntil = new Date(nowMs + 15000);

  const msg = await db
    .collection<OutboundMessageRecord>('messages')
    .findOneAndUpdate(
      {
        direction: 'outbound',
        status: 'queued',
        acceptedByProvider: { $ne: true },
        nextAttemptAt: { $lte: now },
        $or: [
          { lockedUntil: { $exists: false } },
          { lockedUntil: null },
          { lockedUntil: { $lte: now } },
        ],
      },
      {
        $set: { lockedUntil: leaseUntil },
      },
      {
        sort: { nextAttemptAt: 1, createdAt: 1 },
        returnDocument: 'after',
      },
    );

  if (!msg) {
    return false;
  }

  const apiKey = config.pigeon.apiKeys[msg.workspace];
  if (!apiKey) {
    await db.collection('messages').updateOne(
      { workspace: msg.workspace, clientRef: msg.clientRef },
      {
        $set: {
          status: 'failed',
          lastError: 'Unknown workspace API key',
          lockedUntil: null,
        },
      },
    );
    return true;
  }

  const slot = await tryAcquireSendSlot(msg.workspace, nowMs);
  if (!slot.allowed) {
    await db.collection('messages').updateOne(
      { workspace: msg.workspace, clientRef: msg.clientRef },
      {
        $set: {
          nextAttemptAt: new Date(nowMs + slot.waitMs),
          lockedUntil: null,
        },
      },
    );
    return true;
  }

  const timeoutMs = deps.requestTimeoutMs ?? 5000;
  try {
    const res = await fetchFn(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': msg.clientRef,
      },
      body: JSON.stringify({
        to: msg.contact,
        text: msg.text,
        client_ref: msg.clientRef,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { id?: string };
      const setFields: Record<string, unknown> = {
        acceptedByProvider: true,
        lockedUntil: null,
      };
      if (data.id) {
        setFields.messageId = data.id;
      }
      await db.collection('messages').updateOne(
        { workspace: msg.workspace, clientRef: msg.clientRef },
        { $set: setFields },
      );
      return true;
    }

    if (res.status === 429) {
      const retryAfterRaw = Number(res.headers.get('retry-after') ?? '2');
      const retryAfterSec =
        Number.isFinite(retryAfterRaw) && retryAfterRaw > 0
          ? retryAfterRaw
          : 2;
      await setWorkspaceCoolOff(msg.workspace, retryAfterSec, nowMs);
      await db.collection('messages').updateOne(
        { workspace: msg.workspace, clientRef: msg.clientRef },
        {
          $set: {
            nextAttemptAt: new Date(nowMs + Math.ceil(retryAfterSec * 1000) + 150),
            lastError: '429 rate limited',
            lockedUntil: null,
          },
        },
      );
      return true;
    }

    if (res.status >= 400 && res.status < 500) {
      await db.collection('messages').updateOne(
        {
          workspace: msg.workspace,
          clientRef: msg.clientRef,
          status: 'queued',
        },
        {
          $set: {
            status: 'failed',
            lastError: `HTTP ${res.status}`,
            lockedUntil: null,
          },
        },
      );
      return true;
    }

    // 503 or other 5xx: retry with backoff
    const attempts = (msg.attempts ?? 0) + 1;
    await db.collection('messages').updateOne(
      { workspace: msg.workspace, clientRef: msg.clientRef },
      {
        $set: {
          attempts,
          nextAttemptAt: new Date(nowMs + backoffDelayMs(attempts)),
          lastError: `HTTP ${res.status}`,
          lockedUntil: null,
        },
      },
    );
    return true;
  } catch (err) {
    // Timeout (e.g. 12s slow acceptance) or network error: retry with same Idempotency-Key
    const attempts = (msg.attempts ?? 0) + 1;
    const message = err instanceof Error ? err.message : 'Request failed';
    await db.collection('messages').updateOne(
      { workspace: msg.workspace, clientRef: msg.clientRef },
      {
        $set: {
          attempts,
          nextAttemptAt: new Date(nowMs + backoffDelayMs(attempts)),
          lastError: message,
          lockedUntil: null,
        },
      },
    );
    return true;
  }
}

let workerTimer: NodeJS.Timeout | undefined;
let workerRunning = false;

export function startOutboundWorker(intervalMs = 150): void {
  if (workerTimer) return;
  workerTimer = setInterval(async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      // Drain due messages in a batch
      let processed = true;
      let safety = 0;
      while (processed && safety < 25) {
        processed = await processNextOutboundMessage();
        safety++;
      }
    } catch (err) {
      console.error('Outbound worker error:', err);
    } finally {
      workerRunning = false;
    }
  }, intervalMs);
}

export function stopOutboundWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = undefined;
  }
}
