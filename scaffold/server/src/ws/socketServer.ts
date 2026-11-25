import type { IncomingMessage, Server } from 'node:http';
import type { Db } from 'mongodb';
import { WebSocketServer, WebSocket } from 'ws';
import type { Redis } from 'ioredis';
import { getRedis } from '../redis.js';
import {
  getWorkspaceEventsAfter,
  localEventBus,
  type WorkspaceEventFrame,
} from '../services/eventService.js';
import { getSession } from '../services/sessionService.js';

function extractCookieOrBearer(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader === 'string') {
    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === 'sid' || name === 'session' || name === 'session_id') {
        return decodeURIComponent(rest.join('='));
      }
    }
  }
  return undefined;
}

export interface WebSocketHandle {
  close: () => Promise<void>;
}

/**
 * Attaches the `/ws?workspace=<id>&after=<seq>` WebSocket server to an HTTP server.
 * Authenticates via session cookie and enforces workspace membership on upgrade.
 */
export function attachWebSocketServer(
  httpServer: Server,
  dbOverride?: Db,
): WebSocketHandle {
  const wss = new WebSocketServer({ noServer: true });
  const clientsByWorkspace = new Map<string, Set<WebSocket>>();
  const lastSeqBySocket = new WeakMap<WebSocket, number>();
  const bufferingSockets = new WeakMap<WebSocket, WorkspaceEventFrame[]>();

  function sendFrame(ws: WebSocket, frame: WorkspaceEventFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;

    const buffer = bufferingSockets.get(ws);
    if (buffer) {
      buffer.push(frame);
      return;
    }

    const lastSent = lastSeqBySocket.get(ws) ?? 0;
    if (frame.seq <= lastSent) return;

    lastSeqBySocket.set(ws, frame.seq);
    ws.send(JSON.stringify(frame));
  }

  function broadcastToWorkspace(workspace: string, frame: WorkspaceEventFrame): void {
    const sockets = clientsByWorkspace.get(workspace);
    if (!sockets) return;
    for (const ws of sockets) {
      sendFrame(ws, frame);
    }
  }

  const onLocalEvent = (workspace: string, frame: WorkspaceEventFrame) => {
    broadcastToWorkspace(workspace, frame);
  };

  // Subscribe to all workspaces on local bus
  const localListeners = new Map<string, (frame: WorkspaceEventFrame) => void>();
  function ensureLocalSubscription(workspace: string): void {
    if (localListeners.has(workspace)) return;
    const fn = (frame: WorkspaceEventFrame) => onLocalEvent(workspace, frame);
    localListeners.set(workspace, fn);
    localEventBus.on(workspace, fn);
  }

  // Subscribe to Redis Pub/Sub when Redis is available so multi-copy broadcasts work
  let subscriber: Redis | undefined;
  const redis = getRedis();
  if (redis.status === 'ready' || redis.status === 'connecting') {
    subscriber = redis.duplicate({
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    subscriber.on('error', () => {});
    subscriber
      .connect()
      .then(() => subscriber?.psubscribe('ws:events:*'))
      .catch(() => {});
    subscriber.on('pmessage', (_pattern, channel, message) => {
      const workspace = channel.replace(/^ws:events:/, '');
      try {
        const frame = JSON.parse(message) as WorkspaceEventFrame;
        if (frame && typeof frame.seq === 'number') {
          broadcastToWorkspace(workspace, frame);
        }
      } catch {
        // Ignore malformed pubsub payload
      }
    });
  }

  const onUpgrade = async (
    req: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ) => {
    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const workspace = url.searchParams.get('workspace') ?? '';
    const afterRaw = url.searchParams.get('after');
    const afterSeq = afterRaw !== null ? Number(afterRaw) : undefined;

    const sid = extractCookieOrBearer(req);
    const session = sid ? await getSession(sid) : null;
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const isMember =
      workspace !== '' &&
      session.workspaces.some((w) => w.id === workspace);
    if (!isMember) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, async (ws) => {
      let set = clientsByWorkspace.get(workspace);
      if (!set) {
        set = new Set();
        clientsByWorkspace.set(workspace, set);
      }
      set.add(ws);
      ensureLocalSubscription(workspace);

      ws.on('close', () => {
        set?.delete(ws);
        if (set && set.size === 0) {
          clientsByWorkspace.delete(workspace);
        }
      });

      if (afterSeq !== undefined && Number.isFinite(afterSeq)) {
        lastSeqBySocket.set(ws, afterSeq);
        bufferingSockets.set(ws, []);
        try {
          const missed = await getWorkspaceEventsAfter(
            workspace,
            afterSeq,
            dbOverride,
          );
          const buffered = bufferingSockets.get(ws) ?? [];
          bufferingSockets.delete(ws);

          for (const frame of missed) {
            sendFrame(ws, frame);
          }
          for (const frame of buffered) {
            sendFrame(ws, frame);
          }
        } catch {
          bufferingSockets.delete(ws);
        }
      }
    });
  };

  httpServer.on('upgrade', onUpgrade);

  return {
    async close() {
      httpServer.off('upgrade', onUpgrade);
      for (const [workspace, fn] of localListeners) {
        localEventBus.off(workspace, fn);
      }
      localListeners.clear();
      if (subscriber) {
        try {
          await subscriber.quit();
        } catch {
          subscriber.disconnect();
        }
      }
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}
