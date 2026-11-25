import { randomBytes } from 'node:crypto';
import { getRedis } from '../redis.js';

export interface WorkspaceRole {
  id: string;
  role: 'admin' | 'agent' | string;
}

export interface SessionData {
  sub: string;
  workspaces: WorkspaceRole[];
  name?: string;
  email?: string;
}

export interface Session extends SessionData {
  id: string;
  createdAt: number;
  expiresAt: number;
}

// In-memory fallback if Redis is unreachable (e.g. in local unit tests)
const memoryStore = new Map<string, Session>();

const SESSION_TTL_SECONDS = 7 * 24 * 3600; // 7 days

export async function createSession(data: SessionData): Promise<Session> {
  const id = 'sess_' + randomBytes(24).toString('hex');
  const now = Date.now();
  const session: Session = {
    ...data,
    id,
    createdAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
  };

  memoryStore.set(id, session);

  try {
    const redis = getRedis();
    if (redis.status === 'ready') {
      await redis.set(
        `session:${id}`,
        JSON.stringify(session),
        'EX',
        SESSION_TTL_SECONDS,
      );
    }
  } catch {
    // Redis unavailable; memoryStore holds session
  }

  return session;
}

export async function getSession(id: string): Promise<Session | null> {
  if (!id) return null;

  try {
    const redis = getRedis();
    if (redis.status === 'ready') {
      const data = await redis.get(`session:${id}`);
      if (data) {
        return JSON.parse(data) as Session;
      }
    }
  } catch {
    // Fall back to memoryStore
  }

  const inMem = memoryStore.get(id);
  if (!inMem) return null;
  if (Date.now() > inMem.expiresAt) {
    memoryStore.delete(id);
    return null;
  }
  return inMem;
}

export async function deleteSession(id: string): Promise<void> {
  memoryStore.delete(id);
  try {
    const redis = getRedis();
    if (redis.status === 'ready' || redis.status === 'connecting') {
      await redis.del(`session:${id}`);
    }
  } catch {
    // Ignore error
  }
}

export function clearMemorySessions(): void {
  memoryStore.clear();
}
