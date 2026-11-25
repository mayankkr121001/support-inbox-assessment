import type { NextFunction, Request, Response } from 'express';
import { getSession, type Session } from '../services/sessionService.js';

declare global {
  namespace Express {
    interface Request {
      session?: Session;
      user?: {
        sub: string;
        workspaces: Array<{ id: string; role: string }>;
        name?: string;
        email?: string;
      };
    }
  }
}

/**
 * Extracts a session ID from cookies or Authorization header.
 */
export function extractSessionId(req: Request): string | undefined {
  const authHeader = req.header('authorization');
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }

  const cookieHeader = req.header('cookie');
  if (cookieHeader) {
    const cookies = cookieHeader.split(';');
    for (const cookie of cookies) {
      const [name, ...val] = cookie.trim().split('=');
      if (name === 'sid' || name === 'session' || name === 'session_id') {
        return decodeURIComponent(val.join('='));
      }
    }
  }

  return undefined;
}

/**
 * Middleware that loads session if present without rejecting unauthenticated requests.
 */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const sid = extractSessionId(req);
  if (sid) {
    const session = await getSession(sid);
    if (session) {
      req.session = session;
      req.user = {
        sub: session.sub,
        workspaces: session.workspaces,
        name: session.name,
        email: session.email,
      };
    }
  }
  next();
}

/**
 * Middleware that requires a valid user session (401 if missing).
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const sid = extractSessionId(req);
  if (!sid) {
    res.status(401).json({ error: 'Unauthorized: missing session' });
    return;
  }

  const session = await getSession(sid);
  if (!session) {
    res.status(401).json({ error: 'Unauthorized: invalid or expired session' });
    return;
  }

  req.session = session;
  req.user = {
    sub: session.sub,
    workspaces: session.workspaces,
    name: session.name,
    email: session.email,
  };

  next();
}

/**
 * Middleware that verifies the authenticated user has access to the target workspace (403 if not).
 */
export function requireWorkspaceAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const workspace =
    (req.query.workspace as string | undefined) ||
    (req.params.workspace as string | undefined) ||
    (req.body && typeof req.body === 'object' && 'workspace' in req.body
      ? (req.body.workspace as string)
      : undefined);

  if (!workspace) {
    res.status(400).json({ error: 'Missing required workspace parameter' });
    return;
  }

  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const hasAccess = req.user.workspaces.some((w) => w.id === workspace);
  if (!hasAccess) {
    res.status(403).json({ error: 'Forbidden: access to workspace denied' });
    return;
  }

  next();
}
