import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, it } from 'node:test';
import { MongoServerError } from 'mongodb';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { setDb } from '../src/db.js';
import {
  handleMessageStatus,
  processNextOutboundMessage,
  queueReply,
  resetRateLimitState,
  type OutboundMessageRecord,
} from '../src/services/outboundService.js';
import { createSession } from '../src/services/sessionService.js';

function signBody(body: string, timestamp: number): string {
  const mac = createHmac('sha256', config.pigeon.webhookSecret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

async function dispatchToApp(
  app: ReturnType<typeof createApp>,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  rawBody = '',
): Promise<{ status: number; json: Record<string, any> }> {
  const buf = Buffer.from(rawBody, 'utf8');
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  req.headers = {
    ...headers,
    'content-length': String(buf.length),
  };

  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);

  return new Promise((resolve, reject) => {
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return origWrite(chunk as never, ...(rest as [never]));
    }) as typeof res.write;

    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (chunk && typeof chunk !== 'function') {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      const result = origEnd(chunk as never, ...(rest as [never]));
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve({ status: res.statusCode, json: text ? JSON.parse(text) : {} });
      } catch (err) {
        reject(err);
      }
      return result;
    }) as typeof res.end;

    app(req, res);
    if (buf.length > 0) req.push(buf);
    req.push(null);
  });
}

function createFakeOutboundDb() {
  const messages = new Map<string, OutboundMessageRecord>();
  const conversations = new Map<string, Record<string, any>>();
  const webhookEvents = new Set<string>();

  const dupErr = () =>
    new MongoServerError({ message: 'E11000 duplicate key', code: 11000 });

  return {
    messages,
    conversations,
    webhookEvents,
    collection(name: string) {
      if (name === 'messages') {
        return {
          async insertOne(doc: OutboundMessageRecord) {
            const key = `${doc.workspace}|${doc.clientRef}`;
            if (messages.has(key)) throw dupErr();
            messages.set(key, { ...doc });
            return { acknowledged: true };
          },
          async findOne(filter: Record<string, any>) {
            const key = `${filter.workspace}|${filter.clientRef}`;
            const doc = messages.get(key);
            if (!doc) return null;
            if (filter.direction && doc.direction !== filter.direction) return null;
            return { ...doc };
          },
          async findOneAndUpdate(
            filter: Record<string, any>,
            update: { $set: Record<string, any> },
          ) {
            const nowMs =
              filter.nextAttemptAt?.$lte instanceof Date
                ? filter.nextAttemptAt.$lte.getTime()
                : Date.now();

            const candidates = Array.from(messages.values())
              .filter((m) => {
                if (filter.direction && m.direction !== filter.direction) return false;
                if (filter.status && m.status !== filter.status) return false;
                if (
                  filter.acceptedByProvider?.$ne === true &&
                  m.acceptedByProvider === true
                ) {
                  return false;
                }
                if (m.nextAttemptAt.getTime() > nowMs) return false;
                if (m.lockedUntil && m.lockedUntil.getTime() > nowMs) return false;
                return true;
              })
              .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime());

            const target = candidates[0];
            if (!target) return null;

            const updated = { ...target, ...update.$set } as OutboundMessageRecord;
            messages.set(`${target.workspace}|${target.clientRef}`, updated);
            return { ...updated };
          },
          async updateOne(
            filter: Record<string, any>,
            update: { $set: Record<string, any> },
          ) {
            const key = `${filter.workspace}|${filter.clientRef}`;
            const doc = messages.get(key);
            if (!doc) return { matchedCount: 0, modifiedCount: 0 };
            if (filter.status?.$in && !filter.status.$in.includes(doc.status)) {
              return { matchedCount: 0, modifiedCount: 0 };
            }
            if (typeof filter.status === 'string' && doc.status !== filter.status) {
              return { matchedCount: 0, modifiedCount: 0 };
            }
            messages.set(key, { ...doc, ...update.$set });
            return { matchedCount: 1, modifiedCount: 1 };
          },
        };
      }
      if (name === 'conversations') {
        return {
          async updateOne(
            filter: { workspace: string; contact: string },
            update: { $setOnInsert?: Record<string, any>; $max?: { lastActivityAt: Date } },
            opts?: { upsert?: boolean },
          ) {
            const key = `${filter.workspace}|${filter.contact}`;
            const existing = conversations.get(key);
            if (!existing) {
              if (!opts?.upsert) return { matchedCount: 0 };
              conversations.set(key, {
                ...(update.$setOnInsert ?? {}),
                lastActivityAt: update.$max?.lastActivityAt,
              });
            } else if (update.$max?.lastActivityAt) {
              if (update.$max.lastActivityAt > existing.lastActivityAt) {
                existing.lastActivityAt = update.$max.lastActivityAt;
              }
            }
            return { matchedCount: 1 };
          },
        };
      }
      if (name === 'webhook_events') {
        return {
          async insertOne(doc: { eventId: string }) {
            if (webhookEvents.has(doc.eventId)) throw dupErr();
            webhookEvents.add(doc.eventId);
            return { acknowledged: true };
          },
        };
      }
      throw new Error(`Unexpected collection ${name}`);
    },
  };
}

describe('Outbound replies API and deduplication', () => {
  it('queues reply via UI API, creates conversation, and deduplicates client_ref', async () => {
    const fakeDb = createFakeOutboundDb();
    setDb(fakeDb as any);
    const app = createApp();

    const ben = await createSession({
      sub: 'u_ben',
      workspaces: [{ id: 'ws_acme', role: 'agent' }],
    });

    const first = await dispatchToApp(
      app,
      'POST',
      '/api/conversations/%2B14155550101/replies?workspace=ws_acme',
      { 'content-type': 'application/json', cookie: `sid=${ben.id}` },
      JSON.stringify({ text: 'Hello!', client_ref: 'ref_1' }),
    );
    assert.equal(first.status, 202);
    assert.equal(first.json.duplicate, false);
    assert.equal(first.json.status, 'queued');
    assert.equal(fakeDb.messages.size, 1);
    assert.equal(fakeDb.conversations.size, 1);

    // Duplicate client_ref returns 202 and does not create a second message
    const second = await dispatchToApp(
      app,
      'POST',
      '/api/conversations/%2B14155550101/replies?workspace=ws_acme',
      { 'content-type': 'application/json', cookie: `sid=${ben.id}` },
      JSON.stringify({ text: 'Hello!', client_ref: 'ref_1' }),
    );
    assert.equal(second.status, 202);
    assert.equal(second.json.duplicate, true);
    assert.equal(fakeDb.messages.size, 1);

    // Cross-workspace isolation
    const forbidden = await dispatchToApp(
      app,
      'POST',
      '/api/conversations/%2B442079460201/replies?workspace=ws_globex',
      { 'content-type': 'application/json', cookie: `sid=${ben.id}` },
      JSON.stringify({ text: 'Hi' }),
    );
    assert.equal(forbidden.status, 403);
  });

  it('supports POST /__grader/reply with token check and 4xx on unknown workspace', async () => {
    const fakeDb = createFakeOutboundDb();
    setDb(fakeDb as any);
    const app = createApp();

    const unauth = await dispatchToApp(
      app,
      'POST',
      '/__grader/reply',
      { 'content-type': 'application/json' },
      JSON.stringify({ workspace: 'ws_acme', contact: '+14155550101', text: 'Hi', client_ref: 'g1' }),
    );
    assert.equal(unauth.status, 401);

    const badWs = await dispatchToApp(
      app,
      'POST',
      '/__grader/reply',
      { 'content-type': 'application/json', 'x-grader-token': config.graderToken },
      JSON.stringify({ workspace: 'ws_nope', contact: '+14155550101', text: 'Hi', client_ref: 'g1' }),
    );
    assert.ok(badWs.status >= 400 && badWs.status < 500);

    const ok = await dispatchToApp(
      app,
      'POST',
      '/__grader/reply',
      { 'content-type': 'application/json', 'x-grader-token': config.graderToken },
      JSON.stringify({ workspace: 'ws_acme', contact: '+14155550101', text: 'Hi', client_ref: 'g1' }),
    );
    assert.equal(ok.status, 202);
    assert.equal(fakeDb.messages.size, 1);
  });
});

describe('Outbound delivery worker & Pigeon error handling', () => {
  it('sends with Idempotency-Key and marks acceptedByProvider on 200', async () => {
    resetRateLimitState();
    const fakeDb = createFakeOutboundDb();
    await queueReply(
      { workspace: 'ws_acme', contact: '+14155550101', text: 'Hi', clientRef: 'ref_ok' },
      fakeDb as any,
    );

    let capturedHeaders: Record<string, string> = {};
    const fakeFetch: typeof fetch = async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ id: 'pm_123', status: 'accepted' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const processed = await processNextOutboundMessage({
      db: fakeDb as any,
      fetchImpl: fakeFetch,
    });
    assert.equal(processed, true);
    assert.equal(capturedHeaders['idempotency-key'], 'ref_ok');
    assert.equal(capturedHeaders['authorization'], `Bearer ${config.pigeon.apiKeys.ws_acme}`);

    const saved = fakeDb.messages.get('ws_acme|ref_ok')!;
    assert.equal(saved.acceptedByProvider, true);
    assert.equal(saved.messageId, 'pm_123');
    assert.equal(saved.status, 'queued');
  });

  it('respects 429 Retry-After cool-off and retries 503/timeout without failing', async () => {
    resetRateLimitState();
    const fakeDb = createFakeOutboundDb();
    await queueReply(
      { workspace: 'ws_acme', contact: '+14155550101', text: 'Hi', clientRef: 'ref_retry' },
      fakeDb as any,
    );

    let nowMs = Date.now() + 1000;
    let calls = 0;

    // 1. 429 with Retry-After: 2
    await processNextOutboundMessage({
      db: fakeDb as any,
      now: () => nowMs,
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: { 'retry-after': '2' },
        });
      },
    });
    assert.equal(calls, 1);

    // Inside Retry-After (1s later): worker must NOT call Pigeon
    nowMs += 1000;
    await processNextOutboundMessage({
      db: fakeDb as any,
      now: () => nowMs,
      fetchImpl: async () => {
        calls++;
        return new Response('{}', { status: 200 });
      },
    });
    assert.equal(calls, 1);

    // After Retry-After (2.5s later total): hits 503, schedules backoff
    nowMs += 1500;
    await processNextOutboundMessage({
      db: fakeDb as any,
      now: () => nowMs,
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
      },
    });
    assert.equal(calls, 2);
    assert.equal(fakeDb.messages.get('ws_acme|ref_retry')!.status, 'queued');

    // After backoff: timeout error also keeps queued for retry
    nowMs += 5000;
    await processNextOutboundMessage({
      db: fakeDb as any,
      now: () => nowMs,
      fetchImpl: async () => {
        calls++;
        throw new DOMException('The operation timed out', 'TimeoutError');
      },
    });
    assert.equal(calls, 3);
    assert.equal(fakeDb.messages.get('ws_acme|ref_retry')!.status, 'queued');

    // After backoff: succeeds
    nowMs += 10000;
    await processNextOutboundMessage({
      db: fakeDb as any,
      now: () => nowMs,
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ id: 'pm_final', status: 'accepted' }), { status: 200 });
      },
    });
    assert.equal(calls, 4);
    assert.equal(fakeDb.messages.get('ws_acme|ref_retry')!.acceptedByProvider, true);
  });

  it('marks message failed on permanent 4xx error', async () => {
    resetRateLimitState();
    const fakeDb = createFakeOutboundDb();
    await queueReply(
      { workspace: 'ws_acme', contact: '+14155550101', text: 'Hi', clientRef: 'ref_400' },
      fakeDb as any,
    );

    await processNextOutboundMessage({
      db: fakeDb as any,
      fetchImpl: async () => new Response(JSON.stringify({ error: 'bad' }), { status: 400 }),
    });

    assert.equal(fakeDb.messages.get('ws_acme|ref_400')!.status, 'failed');
  });
});

describe('Status webhooks (queued -> sent -> delivered/failed)', () => {
  it('ignores out-of-order sent after delivered and ignores unknown client_ref with 200', async () => {
    const fakeDb = createFakeOutboundDb();
    setDb(fakeDb as any);
    const app = createApp();
    const now = Math.floor(Date.now() / 1000);

    await queueReply(
      { workspace: 'ws_acme', contact: '+14155550101', text: 'Hi', clientRef: 'ref_status' },
      fakeDb as any,
    );

    // Delivered arrives first (out of order)
    const deliveredBody = JSON.stringify({
      id: 'evt_s1',
      type: 'message.status',
      workspace: 'ws_acme',
      occurred_at: '2026-11-18T09:30:05.000Z',
      data: { message_id: 'pm_1', client_ref: 'ref_status', status: 'delivered' },
    });
    const r1 = await dispatchToApp(
      app,
      'POST',
      '/webhooks/pigeon',
      { 'content-type': 'application/json', 'x-pigeon-signature': signBody(deliveredBody, now) },
      deliveredBody,
    );
    assert.equal(r1.status, 200);
    assert.equal(fakeDb.messages.get('ws_acme|ref_status')!.status, 'delivered');

    // Late `sent` arrives second -> must NOT downgrade delivered to sent
    const sentBody = JSON.stringify({
      id: 'evt_s2',
      type: 'message.status',
      workspace: 'ws_acme',
      occurred_at: '2026-11-18T09:30:02.000Z',
      data: { message_id: 'pm_1', client_ref: 'ref_status', status: 'sent' },
    });
    const r2 = await dispatchToApp(
      app,
      'POST',
      '/webhooks/pigeon',
      { 'content-type': 'application/json', 'x-pigeon-signature': signBody(sentBody, now) },
      sentBody,
    );
    assert.equal(r2.status, 200);
    assert.equal(fakeDb.messages.get('ws_acme|ref_status')!.status, 'delivered');

    // Unknown client_ref -> 200 and ignored
    const unknownRes = await handleMessageStatus(
      {
        eventId: 'evt_s3',
        workspace: 'ws_acme',
        clientRef: 'never_sent',
        status: 'sent',
        occurredAt: new Date(),
      },
      fakeDb as any,
    );
    assert.equal(unknownRes.found, false);
  });
});
