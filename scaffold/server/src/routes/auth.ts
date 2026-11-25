import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { extractSessionId, requireAuth } from '../middleware/auth.js';
import {
  buildAuthorizeUrl,
  consumePendingState,
  exchangeAuthorizationCode,
  generatePkcePair,
  savePendingState,
  verifyIdToken,
} from '../services/oidcService.js';
import { createSession, deleteSession } from '../services/sessionService.js';

export const authRouter = Router();

export interface AuthRouterDeps {
  fetchImpl?: typeof fetch;
}

export function createAuthRouter(deps: AuthRouterDeps = {}): Router {
  const router = Router();
  const fetchImpl = deps.fetchImpl ?? fetch;

  /**
   * GET /auth/login
   * Redirects the browser to the Mock IdP with PKCE S256.
   */
  router.get('/auth/login', async (_req, res, next) => {
    try {
      const state = randomBytes(16).toString('hex');
      const nonce = randomBytes(16).toString('hex');
      const { codeVerifier, codeChallenge } = generatePkcePair();
      const redirectUri = config.oidc.redirectUri;

      await savePendingState(state, {
        codeVerifier,
        nonce,
        redirectUri,
      });

      const authorizeUrl = buildAuthorizeUrl({
        state,
        nonce,
        codeChallenge,
        redirectUri,
      });

      res.redirect(302, authorizeUrl);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /auth/callback
   * Exchanges the authorization code, verifies the ID token, and sets a session cookie.
   */
  router.get('/auth/callback', async (req, res, next) => {
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';

      if (!code || !state) {
        res.status(400).json({ error: 'Missing code or state' });
        return;
      }

      const pending = await consumePendingState(state);
      if (!pending) {
        res.status(400).json({ error: 'Invalid or expired OAuth state' });
        return;
      }

      let claims;
      try {
        const tokens = await exchangeAuthorizationCode(
          {
            code,
            codeVerifier: pending.codeVerifier,
            redirectUri: pending.redirectUri,
          },
          fetchImpl,
        );
        claims = await verifyIdToken(
          tokens.id_token,
          pending.nonce,
          fetchImpl,
        );
      } catch (err) {
        res.status(401).json({
          error: err instanceof Error ? err.message : 'Authentication failed',
        });
        return;
      }

      const session = await createSession({
        sub: claims.sub,
        name: claims.name,
        email: claims.email,
        workspaces: claims.workspaces,
      });

      res.setHeader(
        'Set-Cookie',
        `sid=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax`,
      );
      res.redirect(302, config.webOrigin);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /auth/logout
   * Destroys the current session and clears the session cookie.
   */
  router.post('/auth/logout', async (req, res, next) => {
    try {
      const sid = extractSessionId(req);
      if (sid) {
        await deleteSession(sid);
      }
      res.setHeader(
        'Set-Cookie',
        'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      );
      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/me
   * Returns current authenticated user and workspaces, or 401 without session.
   */
  router.get('/api/me', requireAuth, (req, res) => {
    res.status(200).json({
      sub: req.user!.sub,
      workspaces: req.user!.workspaces,
      name: req.user!.name,
      email: req.user!.email,
    });
  });

  return router;
}

authRouter.use(createAuthRouter());
