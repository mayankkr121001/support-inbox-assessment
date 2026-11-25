import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { config } from '../config.js';
import { getRedis } from '../redis.js';
import type { WorkspaceRole } from './sessionService.js';

export interface PendingOidcState {
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
}

export interface VerifiedIdTokenClaims {
  sub: string;
  name?: string;
  email?: string;
  workspaces: WorkspaceRole[];
}

interface JwkKey {
  kid: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

const STATE_TTL_SECONDS = 300;
const memoryStateStore = new Map<string, { data: PendingOidcState; expiresAt: number }>();
const jwksCache = new Map<string, JwkKey>();

export function generatePkcePair(): {
  codeVerifier: string;
  codeChallenge: string;
} {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

export async function savePendingState(
  state: string,
  data: PendingOidcState,
): Promise<void> {
  memoryStateStore.set(state, {
    data,
    expiresAt: Date.now() + STATE_TTL_SECONDS * 1000,
  });

  const redis = getRedis();
  if (redis.status === 'ready') {
    try {
      await redis.set(
        `oidc:state:${state}`,
        JSON.stringify(data),
        'EX',
        STATE_TTL_SECONDS,
      );
    } catch {
      // Fallback already stored in memory
    }
  }
}

export async function consumePendingState(
  state: string,
): Promise<PendingOidcState | null> {
  if (!state) return null;

  const redis = getRedis();
  if (redis.status === 'ready') {
    try {
      const raw = await redis.get(`oidc:state:${state}`);
      if (raw) {
        await redis.del(`oidc:state:${state}`);
        memoryStateStore.delete(state);
        return JSON.parse(raw) as PendingOidcState;
      }
    } catch {
      // Fall back to memoryStateStore
    }
  }

  const entry = memoryStateStore.get(state);
  memoryStateStore.delete(state);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.data;
}

export function buildAuthorizeUrl(params: {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}): string {
  const url = new URL('/authorize', config.oidc.issuer);
  url.searchParams.set('client_id', config.oidc.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('scope', 'openid profile email');
  return url.toString();
}

async function getJwkByKid(
  kid: string,
  fetchImpl: typeof fetch,
): Promise<JwkKey | null> {
  const cached = jwksCache.get(kid);
  if (cached) return cached;

  const res = await fetchImpl(`${config.oidc.issuer}/jwks`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`JWKS fetch failed with HTTP ${res.status}`);
  }
  const body = (await res.json()) as { keys?: JwkKey[] };
  for (const key of body.keys ?? []) {
    if (key.kid) jwksCache.set(key.kid, key);
  }
  return jwksCache.get(kid) ?? null;
}

export async function verifyIdToken(
  idToken: string,
  expectedNonce: string,
  fetchImpl: typeof fetch = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VerifiedIdTokenClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed ID token');
  }
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(
    Buffer.from(headerB64, 'base64url').toString('utf8'),
  ) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported ID token algorithm or missing kid');
  }

  const jwk = await getJwkByKid(header.kid, fetchImpl);
  if (!jwk) {
    throw new Error(`Unknown signing key kid: ${header.kid}`);
  }

  const publicKey = createPublicKey({
    key: jwk as unknown as Record<string, unknown>,
    format: 'jwk',
  });
  const sigValid = verify(
    'rsa-sha256',
    Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'),
    publicKey,
    Buffer.from(sigB64, 'base64url'),
  );
  if (!sigValid) {
    throw new Error('Invalid ID token signature');
  }

  const claims = JSON.parse(
    Buffer.from(payloadB64, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;

  if (claims.iss !== config.oidc.issuer) {
    throw new Error('Invalid ID token issuer');
  }
  if (claims.aud !== config.oidc.clientId) {
    throw new Error('Invalid ID token audience');
  }
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) {
    throw new Error('ID token expired');
  }
  if (claims.nonce !== expectedNonce) {
    throw new Error('ID token nonce mismatch');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) {
    throw new Error('ID token missing sub');
  }

  const rawWorkspaces = Array.isArray(claims.workspaces) ? claims.workspaces : [];
  const workspaces: WorkspaceRole[] = rawWorkspaces
    .filter(
      (w): w is { id: string; role: string } =>
        typeof w === 'object' &&
        w !== null &&
        typeof (w as Record<string, unknown>).id === 'string' &&
        typeof (w as Record<string, unknown>).role === 'string',
    )
    .map((w) => ({ id: w.id, role: w.role }));

  return {
    sub: claims.sub,
    name: typeof claims.name === 'string' ? claims.name : undefined,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    workspaces,
  };
}

export async function exchangeAuthorizationCode(
  params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ id_token: string; access_token: string }> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    client_id: config.oidc.clientId,
    client_secret: config.oidc.clientSecret,
  });

  const res = await fetchImpl(`${config.oidc.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as {
    id_token?: string;
    access_token?: string;
  };
  if (!data.id_token) {
    throw new Error('Token response missing id_token');
  }
  return {
    id_token: data.id_token,
    access_token: data.access_token ?? '',
  };
}

export function clearJwksCache(): void {
  jwksCache.clear();
}
