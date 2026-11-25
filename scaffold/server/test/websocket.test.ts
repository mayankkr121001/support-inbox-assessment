import assert from 'node:assert/strict';
import { createServer, IncomingMessage } from 'node:http';
import { duplexPair } from 'node:stream';
import { describe, it } from 'node:test';
import { MongoServerError } from 'mongodb';
import { claimConversation } from '../src/services/conversationService.js';
import {
  getWorkspaceEventsAfter,
  localEventBus,
  resetFallbackSeq,
  type WorkspaceEventDoc,
  type WorkspaceEventFrame,
} from '../src/services/eventService.js';
import { storeInboundMessage } from '../src/services/inboundService.js';
import { handleMessageStatus, queueReply } from '../src/services/outboundService.js';
import { createSession } from '../src/services/sessionService.js';
import { attachWebSocketServer } from '../src/ws/socketServer.js';

function createFakeWsDb() {
  const counters = new Map<string, number>();
  const workspaceEvents: WorkspaceEventDoc[] = [];
  const conversations = new Map<string, Record<string, any>>();
  const messages = new Map<string, Record<string, any>>();
  const webhookEvents = new Set<string>();
  const dupErr = () => new MongoServerError({ message: 'E11000', code: 11000 });

  return {
    workspaceEvents,
    collection(name: string) {
      if (name === 'counters') {
        return {
          async findOneAndUpdate(
            filter: { _id: string },
            update: { $inc: { seq: number } },
          ) {
            const next = (counters.get(filter._id) ?? 0) + update.$inc.seq;
            counters.set(filter._id, next);
            return { _id: filter._id, seq: next };
          },
        };
      }
      if (name === 'workspace_events') {
        return {
          async insertOne(doc: WorkspaceEventDoc) {
            workspaceEvents.push(doc);
            return { acknowledged: true };
          },
          find(filter: { workspace: string; seq: { $gt: number } }) {
            const list = workspaceEvents
              .filter((e) => e.workspace === filter.workspace && e.seq > filter.seq.$gt)
              .sort((a, b) => a.seq - b.seq);
            return {
              sort() {
                return this;
              },
              async toArray() {
                return list;
              },
            };
          },
        };
      }
      if (name === 'messages') {
        return {
          async insertOne(doc: Record<string, any>) {
            const key = doc.clientRef
              ? `${doc.workspace}|ref|${doc.clientRef}`
              : `${doc.workspace}|msg|${doc.messageId}`;
            if (messages.has(key)) throw dupErr();
            messages.set(key, { ...doc });
            return { acknowledged: true };
          },
          async findOne(filter: Record<string, any>) {
            if (filter.clientRef) {
              return messages.get(`${filter.workspace}|ref|${filter.clientRef}`) ?? null;
            }
            return null;
          },
          async updateOne(filter: Record<string, any>, update: { $set: Record<string, any> }) {
            const key = `${filter.workspace}|ref|${filter.clientRef}`;
            const doc = messages.get(key);
            if (!doc) return { matchedCount: 0, modifiedCount: 0 };
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
            if (!existing && opts?.upsert) {
              conversations.set(key, {
                ...(update.$setOnInsert ?? {}),
                lastActivityAt: update.$max?.lastActivityAt ?? new Date(),
              });
            }
            return { matchedCount: 1 };
          },
          async findOneAndUpdate(
            filter: Record<string, any>,
            update: { $set: Record<string, any> },
          ) {
            const key = `${filter.workspace}|${filter.contact}`;
            const doc = conversations.get(key);
            if (!doc) return null;
            const updated = { ...doc, ...update.$set };
            conversations.set(key, updated);
            return updated;
          },
          async findOne(filter: { workspace: string; contact: string }) {
            return conversations.get(`${filter.workspace}|${filter.contact}`) ?? null;
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

function simulateUpgrade(
  server: ReturnType<typeof createServer>,
  url: string,
  cookie?: string,
): Promise<string> {
  return new Promise((resolve) => {
    const [clientSide, serverSide] = duplexPair();
    const sock = serverSide as typeof serverSide & {
      setTimeout: () => void;
      setNoDelay: () => void;
      setKeepAlive: () => void;
    };
    sock.setTimeout = () => {};
    sock.setNoDelay = () => {};
    sock.setKeepAlive = () => {};

    let output = '';
    let settled = false;
    const origWrite = sock.write.bind(sock);
    sock.write = ((chunk: unknown, ...args: unknown[]) => {
      output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (!settled && output.includes('\r\n\r\n')) {
        settled = true;
        clientSide.destroy();
        resolve(output.split('\r\n')[0]);
      }
      return origWrite(chunk as never, ...(args as [never]));
    }) as typeof sock.write;

    const req = new IncomingMessage(sock as any);
    req.url = url;
    req.method = 'GET';
    req.headers = {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      ...(cookie ? { cookie } : {}),
    };
    server.emit('upgrade', req, sock, Buffer.alloc(0));
  });
}

describe('WebSocket authentication & workspace isolation', () => {
  it('refuses upgrade without session (401) or wrong workspace (403), accepts member (101)', async () => {
    const fakeDb = createFakeWsDb();
    const server = createServer();
    const wsHandle = attachWebSocketServer(server, fakeDb as any);

    try {
      const ben = await createSession({
        sub: 'u_ben',
        workspaces: [{ id: 'ws_acme', role: 'agent' }],
      });

      const noAuth = await simulateUpgrade(server, '/ws?workspace=ws_acme');
      assert.equal(noAuth, 'HTTP/1.1 401 Unauthorized');

      const wrongWs = await simulateUpgrade(
        server,
        '/ws?workspace=ws_globex',
        `sid=${ben.id}`,
      );
      assert.equal(wrongWs, 'HTTP/1.1 403 Forbidden');

      const validWs = await simulateUpgrade(
        server,
        '/ws?workspace=ws_acme',
        `sid=${ben.id}`,
      );
      assert.equal(validWs, 'HTTP/1.1 101 Switching Protocols');
    } finally {
      await wsHandle.close();
    }
  });
});

describe('Real-time workspace events & ?after= replay', () => {
  it('broadcasts inbound message, claim assignment, and status change in order and supports replay', async () => {
    resetFallbackSeq();
    const fakeDb = createFakeWsDb();

    const acmeFrames: WorkspaceEventFrame[] = [];
    const globexFrames: WorkspaceEventFrame[] = [];
    const onAcme = (f: WorkspaceEventFrame) => acmeFrames.push(f);
    const onGlobex = (f: WorkspaceEventFrame) => globexFrames.push(f);

    localEventBus.on('ws_acme', onAcme);
    localEventBus.on('ws_globex', onGlobex);

    try {
      // 1. New customer message arrives
      await storeInboundMessage(
        {
          eventId: 'evt_ws_1',
          workspace: 'ws_acme',
          contact: '+14155550101',
          messageId: 'pmsg_1',
          text: 'Hello support!',
          occurredAt: new Date('2026-11-18T09:30:00.000Z'),
        },
        fakeDb as any,
      );

      // 2. Conversation is assigned
      await claimConversation('ws_acme', '+14155550101', 'u_ben', fakeDb as any);

      // 3. Outbound reply queued and status changes
      await queueReply(
        {
          workspace: 'ws_acme',
          contact: '+14155550101',
          text: 'On it!',
          clientRef: 'ref_ws_1',
        },
        fakeDb as any,
      );
      await handleMessageStatus(
        {
          eventId: 'evt_ws_2',
          workspace: 'ws_acme',
          clientRef: 'ref_ws_1',
          messageId: 'pm_1',
          status: 'delivered',
          occurredAt: new Date('2026-11-18T09:30:05.000Z'),
        },
        fakeDb as any,
      );

      // Tenant isolation: Globex listener received 0 frames
      assert.equal(globexFrames.length, 0);

      // Acme listener received all 3 events with strictly increasing seq
      assert.equal(acmeFrames.length, 3);
      assert.deepEqual(
        acmeFrames.map((f) => [f.seq, f.type]),
        [
          [1, 'message.inbound'],
          [2, 'conversation.assigned'],
          [3, 'message.status'],
        ],
      );

      // Replay after seq=1 returns only seq 2 and 3
      const replayed = await getWorkspaceEventsAfter('ws_acme', 1, fakeDb as any);
      assert.deepEqual(
        replayed.map((f) => f.seq),
        [2, 3],
      );
    } finally {
      localEventBus.off('ws_acme', onAcme);
      localEventBus.off('ws_globex', onGlobex);
    }
  });
});
