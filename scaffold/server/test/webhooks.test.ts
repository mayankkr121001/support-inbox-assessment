import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, it, mock } from 'node:test';
import { MongoServerError } from 'mongodb';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { verifyPigeonSignature } from '../src/routes/webhooks.js';
import { storeInboundMessage } from '../src/services/inboundService.js';

function signBody(body: Buffer | string, timestamp: number, secret = config.pigeon.webhookSecret): string {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const mac = createHmac('sha256', secret).update(`${timestamp}.`).update(buf).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

async function dispatchToApp(
  app: ReturnType<typeof createApp>,
  method: string,
  url: string,
  headers: Record<string, string>,
  rawBody: Buffer | string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const buf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
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
    req.push(buf);
    req.push(null);
  });
}

describe('verifyPigeonSignature', () => {
  const secret = 'whsec_pigeon_dev';
  const body = Buffer.from('{"id":"evt_1"}', 'utf8');
  const now = 1795016513;

  it('accepts a valid signature within 5 minutes', () => {
    assert.equal(verifyPigeonSignature(body, signBody(body, now, secret), secret, now), true);
    assert.equal(verifyPigeonSignature(body, signBody(body, now - 300, secret), secret, now), true);
    assert.equal(verifyPigeonSignature(body, signBody(body, now + 300, secret), secret, now), true);
  });

  it('rejects missing, malformed, wrong-secret, tampered, duplicate-key, and stale signatures', () => {
    assert.equal(verifyPigeonSignature(body, undefined, secret, now), false);
    assert.equal(verifyPigeonSignature(body, '', secret, now), false);
    assert.equal(verifyPigeonSignature(body, 'malformed', secret, now), false);
    assert.equal(verifyPigeonSignature(body, signBody(body, now, 'wrong'), secret, now), false);
    assert.equal(verifyPigeonSignature(Buffer.from('{"id":"evt_2"}'), signBody(body, now, secret), secret, now), false);
    assert.equal(verifyPigeonSignature(body, signBody(body, now - 301, secret), secret, now), false);
    assert.equal(verifyPigeonSignature(body, signBody(body, now + 301, secret), secret, now), false);
    const sig = signBody(body, now, secret);
    assert.equal(verifyPigeonSignature(body, `${sig},t=${now}`, secret, now), false);
  });
});

describe('POST /webhooks/pigeon contract', () => {
  it('returns 401 when signature is missing, wrong, or stale (even if body is invalid JSON)', async () => {
    const app = createApp();
    const now = Math.floor(Date.now() / 1000);

    const missing = await dispatchToApp(app, 'POST', '/webhooks/pigeon', { 'content-type': 'application/json' }, '{bad');
    assert.equal(missing.status, 401);

    const forged = await dispatchToApp(
      app,
      'POST',
      '/webhooks/pigeon',
      { 'content-type': 'application/json', 'x-pigeon-signature': signBody('{bad', now, 'wrong-secret') },
      '{bad',
    );
    assert.equal(forged.status, 401);

    const stale = await dispatchToApp(
      app,
      'POST',
      '/webhooks/pigeon',
      { 'content-type': 'application/json', 'x-pigeon-signature': signBody('{"id":"evt_1"}', now - 3600) },
      '{"id":"evt_1"}',
    );
    assert.equal(stale.status, 401);
  });

  it('returns 400 for a valid signature with unparseable JSON or invalid inbound payload', async () => {
    const app = createApp();
    const now = Math.floor(Date.now() / 1000);

    const badJson = await dispatchToApp(
      app,
      'POST',
      '/webhooks/pigeon',
      { 'content-type': 'application/json', 'x-pigeon-signature': signBody('{not-json', now) },
      '{not-json',
    );
    assert.equal(badJson.status, 400);

    const badInbound = JSON.stringify({
      id: 'evt_1',
      type: 'message.inbound',
      workspace: 'ws_acme',
      occurred_at: '2026-11-18T09:30:00.123Z',
      data: { from: '+14155550101' },
    });
    const missingFields = await dispatchToApp(
      app,
      'POST',
      '/webhooks/pigeon',
      { 'content-type': 'application/json', 'x-pigeon-signature': signBody(badInbound, now) },
      badInbound,
    );
    assert.equal(missingFields.status, 400);
  });

  it('returns 200 and ignores unknown event types and unknown workspaces', async () => {
    const app = createApp();
    const now = Math.floor(Date.now() / 1000);

    const unknownTypeBody = JSON.stringify({ id: 'evt_u1', type: 'contact.updated', workspace: 'ws_acme' });
    const unknownType = await dispatchToApp(
      app,
      'POST',
      '/webhooks/pigeon',
      { 'content-type': 'application/json', 'x-pigeon-signature': signBody(unknownTypeBody, now) },
      unknownTypeBody,
    );
    assert.equal(unknownType.status, 200);

    const unknownWsBody = JSON.stringify({
      id: 'evt_u2',
      type: 'message.inbound',
      workspace: 'ws_unknown',
      occurred_at: '2026-11-18T09:30:00.123Z',
      data: { message_id: 'pmsg_1', from: '+14155550101', text: 'hi' },
    });
    const unknownWs = await dispatchToApp(
      app,
      'POST',
      '/webhooks/pigeon',
      { 'content-type': 'application/json', 'x-pigeon-signature': signBody(unknownWsBody, now) },
      unknownWsBody,
    );
    assert.equal(unknownWs.status, 200);
  });
});

describe('storeInboundMessage deduplication and conversation upsert', () => {
  it('stores message, creates conversation, prevents duplicates, and handles upsert race', async () => {
    const messages = new Map<string, Record<string, unknown>>();
    const conversations = new Map<string, Record<string, unknown>>();
    const webhookEvents = new Set<string>();

    const dupErr = () => new MongoServerError({ message: 'E11000 duplicate key', code: 11000 });

    const fakeDb = {
      collection(name: string) {
        if (name === 'messages') {
          return {
            async insertOne(doc: Record<string, unknown>) {
              const key = `${doc.workspace}|${doc.messageId}`;
              if (messages.has(key)) throw dupErr();
              messages.set(key, doc);
              return { acknowledged: true };
            },
          };
        }
        if (name === 'conversations') {
          return {
            async updateOne(
              filter: { workspace: string; contact: string },
              update: { $setOnInsert?: Record<string, unknown>; $max?: { lastActivityAt: Date } },
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
                const prev = existing.lastActivityAt as Date;
                if (update.$max.lastActivityAt > prev) {
                  existing.lastActivityAt = update.$max.lastActivityAt;
                }
              }
              return { matchedCount: 1 };
            },
          };
        }
        if (name === 'webhook_events') {
          return {
            async insertOne(doc: Record<string, unknown>) {
              const id = String(doc.eventId);
              if (webhookEvents.has(id)) throw dupErr();
              webhookEvents.add(id);
              return { acknowledged: true };
            },
          };
        }
        throw new Error(`Unexpected collection ${name}`);
      },
    };

    const t1 = new Date('2026-11-18T09:30:05.000Z');
    const tOlder = new Date('2026-11-18T09:30:01.000Z');

    const first = await storeInboundMessage(
      {
        eventId: 'evt_1',
        workspace: 'ws_acme',
        contact: '+14155550101',
        messageId: 'pmsg_2',
        text: 'Second by time, arrived first',
        occurredAt: t1,
      },
      fakeDb as never,
    );
    assert.equal(first.duplicate, false);
    assert.equal(messages.size, 1);
    assert.equal(conversations.size, 1);
    assert.equal(conversations.get('ws_acme|+14155550101')?.lastActivityAt, t1);

    // Duplicate delivery of the exact same event/message
    const dup = await storeInboundMessage(
      {
        eventId: 'evt_1',
        workspace: 'ws_acme',
        contact: '+14155550101',
        messageId: 'pmsg_2',
        text: 'Second by time, arrived first',
        occurredAt: t1,
      },
      fakeDb as never,
    );
    assert.equal(dup.duplicate, true);
    assert.equal(messages.size, 1);
    assert.equal(conversations.size, 1);

    // Out-of-order older message must not move lastActivityAt backwards
    const older = await storeInboundMessage(
      {
        eventId: 'evt_2',
        workspace: 'ws_acme',
        contact: '+14155550101',
        messageId: 'pmsg_1',
        text: 'Earlier message arriving late',
        occurredAt: tOlder,
      },
      fakeDb as never,
    );
    assert.equal(older.duplicate, false);
    assert.equal(messages.size, 2);
    assert.equal(conversations.size, 1);
    assert.equal(conversations.get('ws_acme|+14155550101')?.lastActivityAt, t1);

    mock.restoreAll();
  });
});
