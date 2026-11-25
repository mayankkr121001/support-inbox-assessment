import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, it } from 'node:test';
import { MongoServerError } from 'mongodb';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { setDb } from '../src/db.js';
import {
  claimConversation,
  closeConversation,
  getConversation,
  getConversationMessages,
  listConversations,
  reopenConversation,
  type ConversationDoc,
  type MessageDoc,
} from '../src/services/conversationService.js';
import { createSession } from '../src/services/sessionService.js';

async function dispatchToApp(
  app: ReturnType<typeof createApp>,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  rawBody: Buffer | string = '',
): Promise<{ status: number; json: Record<string, any> }> {
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
    if (buf.length > 0) {
      req.push(buf);
    }
    req.push(null);
  });
}

function createFakeDb() {
  const conversations = new Map<string, ConversationDoc>();
  const messages: MessageDoc[] = [];

  const dupErr = () =>
    new MongoServerError({ message: 'E11000 duplicate key', code: 11000 });

  return {
    conversations,
    messages,
    collection(name: string) {
      if (name === 'conversations') {
        return {
          async updateOne(
            filter: { workspace: string; contact: string },
            update: { $setOnInsert?: Partial<ConversationDoc> },
            opts?: { upsert?: boolean },
          ) {
            const key = `${filter.workspace}|${filter.contact}`;
            if (!conversations.has(key)) {
              if (opts?.upsert) {
                conversations.set(key, {
                  workspace: filter.workspace,
                  contact: filter.contact,
                  assignee: null,
                  status: 'open',
                  lastActivityAt: new Date(),
                  createdAt: new Date(),
                  ...(update.$setOnInsert as any),
                });
                return { matchedCount: 0, upsertedCount: 1 };
              }
              return { matchedCount: 0 };
            }
            return { matchedCount: 1 };
          },
          async findOneAndUpdate(
            filter: Record<string, any>,
            update: { $set: Record<string, any> },
            _opts?: any,
          ) {
            const key = `${filter.workspace}|${filter.contact}`;
            const doc = conversations.get(key);
            if (!doc) return null;

            if (filter.$or) {
              const matchesOr = filter.$or.some((cond: any) => {
                if (cond.assignee === null) return doc.assignee === null;
                return doc.assignee === cond.assignee;
              });
              if (!matchesOr) return null;
            }

            const updated: ConversationDoc = { ...doc, ...update.$set };
            conversations.set(key, updated);
            return updated;
          },
          async findOne(filter: { workspace: string; contact: string }) {
            const key = `${filter.workspace}|${filter.contact}`;
            return conversations.get(key) ?? null;
          },
          find(filter: Record<string, any>) {
            let list = Array.from(conversations.values()).filter(
              (c) => c.workspace === filter.workspace,
            );
            if (filter.lastActivityAt?.$lt) {
              const lt = filter.lastActivityAt.$lt.getTime();
              list = list.filter((c) => c.lastActivityAt.getTime() < lt);
            }
            return {
              sort(sortObj: Record<string, number>) {
                if (sortObj.lastActivityAt === -1) {
                  list.sort(
                    (a, b) =>
                      b.lastActivityAt.getTime() - a.lastActivityAt.getTime(),
                  );
                }
                return this;
              },
              limit(n: number) {
                list = list.slice(0, n);
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
          async insertOne(doc: MessageDoc) {
            messages.push(doc);
            return { acknowledged: true };
          },
          find(filter: { workspace: string; contact: string }) {
            const filtered = messages.filter(
              (m) =>
                m.workspace === filter.workspace && m.contact === filter.contact,
            );
            return {
              sort(_sortObj: any) {
                return this;
              },
              async toArray() {
                return filtered;
              },
            };
          },
        };
      }
      throw new Error(`Unexpected collection ${name}`);
    },
  };
}

describe('Conversation Service logic', () => {
  it('claims a new contact, prevents duplicate claims by another agent, allows holder claim again', async () => {
    const fakeDb = createFakeDb();
    const ws = 'ws_acme';
    const contact = '+14155550101';

    // 1. First claim on brand new contact
    const res1 = await claimConversation(ws, contact, 'u_ben', fakeDb as any);
    assert.equal(res1.success, true);
    if (res1.success) {
      assert.equal(res1.conversation.assignee, 'u_ben');
    }

    // 2. Another agent attempts claim -> 409 Conflict
    const res2 = await claimConversation(ws, contact, 'u_asha', fakeDb as any);
    assert.equal(res2.success, false);
    if (!res2.success) {
      assert.equal(res2.status, 409);
      assert.equal(res2.assignee, 'u_ben');
    }

    // 3. Current holder claims again -> 200 Success
    const res3 = await claimConversation(ws, contact, 'u_ben', fakeDb as any);
    assert.equal(res3.success, true);
    if (res3.success) {
      assert.equal(res3.conversation.assignee, 'u_ben');
    }
  });

  it('closes and reopens a conversation', async () => {
    const fakeDb = createFakeDb();
    const ws = 'ws_acme';
    const contact = '+14155550101';

    await claimConversation(ws, contact, 'u_ben', fakeDb as any);

    const closed = await closeConversation(ws, contact, fakeDb as any);
    assert.equal(closed?.status, 'closed');

    const reopened = await reopenConversation(ws, contact, fakeDb as any);
    assert.equal(reopened?.status, 'open');
  });

  it('lists conversations newest activity first', async () => {
    const fakeDb = createFakeDb();
    const ws = 'ws_acme';

    fakeDb.conversations.set(`${ws}|c1`, {
      workspace: ws,
      contact: 'c1',
      assignee: null,
      status: 'open',
      lastActivityAt: new Date(1000),
      createdAt: new Date(1000),
    });
    fakeDb.conversations.set(`${ws}|c2`, {
      workspace: ws,
      contact: 'c2',
      assignee: null,
      status: 'open',
      lastActivityAt: new Date(3000),
      createdAt: new Date(3000),
    });
    fakeDb.conversations.set(`${ws}|c3`, {
      workspace: ws,
      contact: 'c3',
      assignee: null,
      status: 'open',
      lastActivityAt: new Date(2000),
      createdAt: new Date(2000),
    });

    const list = await listConversations({ workspace: ws }, fakeDb as any);
    assert.deepEqual(
      list.map((c) => c.contact),
      ['c2', 'c3', 'c1'],
    );
  });
});

describe('Conversation APIs and Workspace Isolation', () => {
  it('returns 401 when no session is provided', async () => {
    const fakeDb = createFakeDb();
    setDb(fakeDb as any);
    const app = createApp();
    const res = await dispatchToApp(app, 'GET', '/api/conversations?workspace=ws_acme');
    assert.equal(res.status, 401);
  });

  it('returns 403 when session user does not belong to the requested workspace', async () => {
    const fakeDb = createFakeDb();
    setDb(fakeDb as any);
    const app = createApp();
    const session = await createSession({
      sub: 'u_ben',
      workspaces: [{ id: 'ws_acme', role: 'agent' }],
    });

    // Requesting ws_globex with an Acme-only session
    const res = await dispatchToApp(app, 'GET', '/api/conversations?workspace=ws_globex', {
      cookie: `sid=${session.id}`,
    });
    assert.equal(res.status, 403);
  });

  it('allows access when user belongs to the requested workspace', async () => {
    const fakeDb = createFakeDb();
    setDb(fakeDb as any);
    const app = createApp();
    const session = await createSession({
      sub: 'u_ben',
      workspaces: [{ id: 'ws_acme', role: 'agent' }],
    });

    const res = await dispatchToApp(app, 'GET', '/api/conversations?workspace=ws_acme', {
      cookie: `sid=${session.id}`,
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.conversations));
  });

  it('supports multi-workspace users like Eli Novak', async () => {
    const fakeDb = createFakeDb();
    setDb(fakeDb as any);
    const app = createApp();
    const session = await createSession({
      sub: 'u_eli',
      workspaces: [
        { id: 'ws_acme', role: 'agent' },
        { id: 'ws_globex', role: 'agent' },
      ],
    });

    const acmeRes = await dispatchToApp(app, 'GET', '/api/conversations?workspace=ws_acme', {
      cookie: `sid=${session.id}`,
    });
    assert.equal(acmeRes.status, 200);

    const globexRes = await dispatchToApp(app, 'GET', '/api/conversations?workspace=ws_globex', {
      cookie: `sid=${session.id}`,
    });
    assert.equal(globexRes.status, 200);
  });

  it('claims a conversation via API and blocks second agent with 409', async () => {
    const fakeDb = createFakeDb();
    setDb(fakeDb as any);
    const app = createApp();

    const ben = await createSession({
      sub: 'u_ben',
      workspaces: [{ id: 'ws_acme', role: 'agent' }],
    });
    const asha = await createSession({
      sub: 'u_asha',
      workspaces: [{ id: 'ws_acme', role: 'admin' }],
    });

    // Ben claims
    const claim1 = await dispatchToApp(
      app,
      'POST',
      '/api/conversations/%2B14155550101/claim?workspace=ws_acme',
      { cookie: `sid=${ben.id}` },
    );
    assert.equal(claim1.status, 200);
    assert.equal(claim1.json.conversation.assignee, 'u_ben');

    // Asha attempts claim on same conversation
    const claim2 = await dispatchToApp(
      app,
      'POST',
      '/api/conversations/%2B14155550101/claim?workspace=ws_acme',
      { cookie: `sid=${asha.id}` },
    );
    assert.equal(claim2.status, 409);
    assert.equal(claim2.json.assignee, 'u_ben');
  });

  it('closes and reopens a conversation via API', async () => {
    const fakeDb = createFakeDb();
    setDb(fakeDb as any);
    const app = createApp();

    const ben = await createSession({
      sub: 'u_ben',
      workspaces: [{ id: 'ws_acme', role: 'agent' }],
    });

    await dispatchToApp(
      app,
      'POST',
      '/api/conversations/%2B14155550101/claim?workspace=ws_acme',
      { cookie: `sid=${ben.id}` },
    );

    const closeRes = await dispatchToApp(
      app,
      'POST',
      '/api/conversations/%2B14155550101/close?workspace=ws_acme',
      { cookie: `sid=${ben.id}` },
    );
    assert.equal(closeRes.status, 200);
    assert.equal(closeRes.json.conversation.status, 'closed');

    const reopenRes = await dispatchToApp(
      app,
      'POST',
      '/api/conversations/%2B14155550101/reopen?workspace=ws_acme',
      { cookie: `sid=${ben.id}` },
    );
    assert.equal(reopenRes.status, 200);
    assert.equal(reopenRes.json.conversation.status, 'open');
  });

  it('enforces x-grader-token on POST /__grader/claim', async () => {
    const fakeDb = createFakeDb();
    setDb(fakeDb as any);
    const app = createApp();

    // 1. Missing token
    const res1 = await dispatchToApp(
      app,
      'POST',
      '/__grader/claim',
      { 'content-type': 'application/json' },
      JSON.stringify({ workspace: 'ws_acme', contact: '+14155550101', agent: 'grader_1' }),
    );
    assert.equal(res1.status, 401);

    // 2. Wrong token
    const res2 = await dispatchToApp(
      app,
      'POST',
      '/__grader/claim',
      { 'content-type': 'application/json', 'x-grader-token': 'wrong-token' },
      JSON.stringify({ workspace: 'ws_acme', contact: '+14155550101', agent: 'grader_1' }),
    );
    assert.equal(res2.status, 401);

    // 3. Valid token
    const res3 = await dispatchToApp(
      app,
      'POST',
      '/__grader/claim',
      { 'content-type': 'application/json', 'x-grader-token': config.graderToken },
      JSON.stringify({ workspace: 'ws_acme', contact: '+14155550101', agent: 'grader_1' }),
    );
    assert.equal(res3.status, 200);
    assert.equal(res3.json.assignee, 'grader_1');
  });
});
