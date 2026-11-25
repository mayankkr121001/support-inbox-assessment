import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import express from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, it } from 'node:test';
import { config } from '../src/config.js';
import { setDb } from '../src/db.js';
import { errorHandler, notFoundHandler } from '../src/middleware/errorHandler.js';
import { createAuthRouter } from '../src/routes/auth.js';
import { conversationsRouter } from '../src/routes/conversations.js';
import { clearJwksCache } from '../src/services/oidcService.js';

async function dispatchToApp(
  app: ReturnType<typeof express>,
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: Record<string, any>;
}> {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  req.headers = headers;

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
      let json: Record<string, any> = {};
      try {
        if (text && text.startsWith('{')) json = JSON.parse(text);
      } catch (err) {
        reject(err);
        return result;
      }
      resolve({ status: res.statusCode, headers: res.getHeaders(), json });
      return result;
    }) as typeof res.end;

    app(req, res);
    req.push(null);
  });
}

function signRs256Jwt(
  claims: Record<string, unknown>,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  kid: string,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }),
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const sig = signer.sign(privateKey).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

function buildTestApp(fetchImpl: typeof fetch) {
  const app = express();
  app.use(express.json());
  app.use(createAuthRouter({ fetchImpl }));
  app.use(conversationsRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('Mock IdP OIDC Authentication & Workspace Isolation', () => {
  it('completes full PKCE login flow, sets session cookie, serves /api/me, and enforces workspace isolation', async () => {
    clearJwksCache();
    setDb({
      collection: () => ({
        find: () => ({
          sort: () => ({
            limit: () => ({
              toArray: async () => [],
            }),
          }),
        }),
      }),
    } as any);

    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const kid = 'test-kid-1';

    let capturedChallenge = '';
    let capturedNonce = '';

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === `${config.oidc.issuer}/token`) {
        const params = new URLSearchParams(String(init?.body ?? ''));
        assert.equal(params.get('grant_type'), 'authorization_code');
        assert.equal(params.get('code'), 'auth_code_123');
        assert.equal(params.get('client_id'), config.oidc.clientId);
        assert.equal(params.get('redirect_uri'), config.oidc.redirectUri);

        const verifier = params.get('code_verifier') ?? '';
        const computedChallenge = createHash('sha256')
          .update(verifier)
          .digest('base64url');
        assert.equal(computedChallenge, capturedChallenge);

        const now = Math.floor(Date.now() / 1000);
        const idToken = signRs256Jwt(
          {
            iss: config.oidc.issuer,
            aud: config.oidc.clientId,
            sub: 'u_ben',
            name: 'Ben Ortiz',
            email: 'ben@acme.test',
            nonce: capturedNonce,
            iat: now,
            exp: now + 3600,
            workspaces: [{ id: 'ws_acme', role: 'agent' }],
          },
          privateKey,
          kid,
        );

        return new Response(
          JSON.stringify({
            access_token: 'at_123',
            token_type: 'Bearer',
            expires_in: 3600,
            id_token: idToken,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url === `${config.oidc.issuer}/jwks`) {
        return new Response(
          JSON.stringify({
            keys: [{ ...publicJwk, kid, use: 'sig', alg: 'RS256' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const app = buildTestApp(fakeFetch);

    // 1. GET /api/me without session -> 401
    const anonMe = await dispatchToApp(app, 'GET', '/api/me');
    assert.equal(anonMe.status, 401);

    // 2. GET /auth/login -> 302 to IdP /authorize with PKCE S256
    const loginRes = await dispatchToApp(app, 'GET', '/auth/login');
    assert.equal(loginRes.status, 302);
    const location = String(loginRes.headers.location);
    const authUrl = new URL(location);
    assert.equal(authUrl.origin, config.oidc.issuer);
    assert.equal(authUrl.pathname, '/authorize');
    assert.equal(authUrl.searchParams.get('client_id'), config.oidc.clientId);
    assert.equal(authUrl.searchParams.get('response_type'), 'code');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    capturedChallenge = authUrl.searchParams.get('code_challenge') ?? '';
    capturedNonce = authUrl.searchParams.get('nonce') ?? '';
    const state = authUrl.searchParams.get('state') ?? '';
    assert.ok(capturedChallenge && capturedNonce && state);

    // 3. GET /auth/callback -> exchanges code, verifies RS256 ID token, sets cookie, redirects
    const cbRes = await dispatchToApp(
      app,
      'GET',
      `/auth/callback?code=auth_code_123&state=${encodeURIComponent(state)}`,
    );
    assert.equal(cbRes.status, 302);
    assert.equal(cbRes.headers.location, config.webOrigin);
    const setCookie = String(cbRes.headers['set-cookie']);
    assert.ok(setCookie.includes('sid='));
    assert.ok(setCookie.includes('HttpOnly'));
    const sidCookie = setCookie.split(';')[0];

    // 4. Reusing the same state must fail with 400
    const replayCb = await dispatchToApp(
      app,
      'GET',
      `/auth/callback?code=auth_code_123&state=${encodeURIComponent(state)}`,
    );
    assert.equal(replayCb.status, 400);

    // 5. GET /api/me with session cookie -> 200 u_ben
    const meRes = await dispatchToApp(app, 'GET', '/api/me', {
      cookie: sidCookie,
    });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.json.sub, 'u_ben');
    assert.deepEqual(meRes.json.workspaces, [{ id: 'ws_acme', role: 'agent' }]);

    // 6. Workspace isolation: u_ben can access ws_acme (200) but NOT ws_globex (403)
    const ownWs = await dispatchToApp(
      app,
      'GET',
      '/api/conversations?workspace=ws_acme',
      { cookie: sidCookie },
    );
    assert.equal(ownWs.status, 200);

    const otherWs = await dispatchToApp(
      app,
      'GET',
      '/api/conversations?workspace=ws_globex',
      { cookie: sidCookie },
    );
    assert.equal(otherWs.status, 403);

    // 7. POST /auth/logout invalidates session
    const logoutRes = await dispatchToApp(app, 'POST', '/auth/logout', {
      cookie: sidCookie,
    });
    assert.equal(logoutRes.status, 200);

    const afterLogoutMe = await dispatchToApp(app, 'GET', '/api/me', {
      cookie: sidCookie,
    });
    assert.equal(afterLogoutMe.status, 401);
  });

  it('rejects ID token with invalid signature or wrong nonce', async () => {
    clearJwksCache();
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const { privateKey: wrongPrivateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const kid = 'test-kid-2';

    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === `${config.oidc.issuer}/token`) {
        const now = Math.floor(Date.now() / 1000);
        const badToken = signRs256Jwt(
          {
            iss: config.oidc.issuer,
            aud: config.oidc.clientId,
            sub: 'u_ben',
            nonce: 'wrong-nonce',
            iat: now,
            exp: now + 3600,
            workspaces: [{ id: 'ws_acme', role: 'agent' }],
          },
          wrongPrivateKey,
          kid,
        );
        return new Response(
          JSON.stringify({ access_token: 'at', id_token: badToken }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === `${config.oidc.issuer}/jwks`) {
        return new Response(
          JSON.stringify({ keys: [{ ...publicJwk, kid, use: 'sig', alg: 'RS256' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const app = buildTestApp(fakeFetch);
    const loginRes = await dispatchToApp(app, 'GET', '/auth/login');
    const state = new URL(String(loginRes.headers.location)).searchParams.get('state')!;

    const cbRes = await dispatchToApp(
      app,
      'GET',
      `/auth/callback?code=c1&state=${encodeURIComponent(state)}`,
    );
    assert.equal(cbRes.status, 401);
  });
});
