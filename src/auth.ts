/**
 * Authentication: exchange a Pax8 API credential (client id + secret) for a bearer token and keep
 * one fresh.
 *
 * Pax8 issues a JWT from an Auth0 tenant via the OAuth 2.0 client-credentials grant, with
 * `audience` set to the API. Observed lifetime is 24 hours. The token's own `exp` claim drives
 * refresh, falling back to `expires_in`, so a change to the lifetime needs no code change.
 *
 * A Pax8 API credential is not limited to reads. This library is read-only by construction (see
 * `http.ts`), but the secret itself is not: store it where only the process that needs it can read it.
 */
import { Pax8ApiError } from './errors.js';

/** Pax8's token endpoint. */
export const TOKEN_URL = 'https://token-manager.pax8.com/oauth/token';

/** The `audience` the token must be issued for. */
export const AUDIENCE = 'https://api.pax8.com';

/** Refresh this long before expiry, so a request never leaves with a token that expires in flight. */
export const REFRESH_SKEW_MS = 5 * 60_000;

/**
 * How the client authenticates.
 *
 * - `{ clientId, clientSecret }` — a Pax8 API credential. The client requests a token on first use,
 *   caches it, and requests a new one before it expires or when a request comes back 401. Use this.
 * - `{ token }` — a bearer token obtained elsewhere (an n8n credential, another process). Used
 *   as-is and never refreshed; once it expires every call fails with 401.
 */
export type Pax8Auth =
  | { clientId: string; clientSecret: string; token?: undefined }
  | { token: string; clientId?: undefined; clientSecret?: undefined };

export interface TokenRequestOptions {
  /** Defaults to {@link TOKEN_URL}. Must be HTTPS. */
  tokenUrl?: string;
  /** Defaults to {@link AUDIENCE}. */
  audience?: string;
  fetchImpl: typeof fetch;
  /** Injectable clock in epoch ms. Defaults to `Date.now`. */
  nowMs?: () => number;
}

/** A token plus its expiry in epoch ms, when one is known. */
export interface IssuedToken {
  token: string;
  expiresAtMs?: number;
}

/**
 * What a token is allowed to do, without the token itself or the ids of the user it acts as.
 * Use it to audit what a credential's token carries.
 */
export interface TokenClaims {
  /** The `scope` claim, split on spaces. */
  scopes: string[];
  audience?: string | string[];
  issuer?: string;
  expiresAtMs?: number;
  /** `clientMetadata.applicationName`, the name the credential was given in Pax8. */
  applicationName?: string;
  /** `clientMetadata.accountLevel`, for example `PARTNER`. */
  accountLevel?: string;
}

/** Perform the token exchange once. Most callers want the client, which does this for them. */
export async function requestToken(clientId: string, clientSecret: string, opts: TokenRequestOptions): Promise<IssuedToken> {
  if (!clientId || !clientSecret) throw new Error('Pax8 token request: clientId and clientSecret are both required.');
  const tokenUrl = opts.tokenUrl ?? TOKEN_URL;
  if (!/^https:\/\//i.test(tokenUrl)) throw new Error(`Pax8 tokenUrl must be HTTPS, got: ${tokenUrl}`);
  const path = new URL(tokenUrl).pathname;
  const res = await opts.fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      audience: opts.audience ?? AUDIENCE,
      grant_type: 'client_credentials',
    }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* keep raw text */
  }
  if (!res.ok) {
    // Auth0 answers `{ error, error_description }`. Neither carries the secret.
    const b = (body ?? {}) as { error?: unknown; error_description?: unknown };
    const detail = [b.error, b.error_description].filter((x) => typeof x === 'string').join(': ') || res.statusText || 'token request failed';
    const hint = res.status === 401 || res.status === 403 ? ' The credential was rejected; check it was copied whole and has not been rotated.' : '';
    throw new Pax8ApiError(`Pax8 POST ${path} -> ${res.status}: ${detail}.${hint}`, res.status, 'POST', path, body);
  }
  const r = (body ?? {}) as { access_token?: unknown; expires_in?: unknown };
  if (typeof r.access_token !== 'string' || !r.access_token) {
    throw new Pax8ApiError(`Pax8 POST ${path} -> ${res.status} but no access_token in the response.`, res.status, 'POST', path, undefined);
  }
  const now = (opts.nowMs ?? Date.now)();
  const expiresAtMs = jwtExpiryMs(r.access_token) ?? (typeof r.expires_in === 'number' ? now + r.expires_in * 1000 : undefined);
  return { token: r.access_token, expiresAtMs };
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const parsed: unknown = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The `exp` claim of a JWT in epoch ms, or `undefined` when it is absent or unreadable. */
export function jwtExpiryMs(token: string): number | undefined {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 : undefined;
}

/**
 * The permission-bearing claims of a Pax8 token. Never returns the token, `sub`, or the user and
 * entity ids in `clientMetadata`, so the result is safe to log.
 */
export function tokenClaims(token: string): TokenClaims {
  const p = jwtPayload(token) ?? {};
  const meta = (p.clientMetadata ?? {}) as { applicationName?: unknown; accountLevel?: unknown };
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    scopes: typeof p.scope === 'string' ? p.scope.split(' ').filter(Boolean) : [],
    audience: typeof p.aud === 'string' || Array.isArray(p.aud) ? (p.aud as string | string[]) : undefined,
    issuer: str(p.iss),
    expiresAtMs: typeof p.exp === 'number' ? p.exp * 1000 : undefined,
    applicationName: str(meta.applicationName),
    accountLevel: str(meta.accountLevel),
  };
}

/**
 * Hands out a valid token. Concurrent callers during a token request share one in-flight request,
 * so a burst of parallel reads costs one exchange, not one each.
 */
export class TokenSource {
  #current?: IssuedToken;
  #pending?: Promise<IssuedToken>;
  readonly #nowMs: () => number;

  constructor(
    private readonly auth: Pax8Auth,
    private readonly request: TokenRequestOptions,
  ) {
    if (!(auth.clientId && auth.clientSecret) && !auth.token) {
      throw new Error('Pax8 auth: provide { clientId, clientSecret } or { token }.');
    }
    this.#nowMs = request.nowMs ?? Date.now;
    if (auth.token) this.#current = { token: auth.token };
  }

  /** True when a 401 can be recovered by requesting a new token. */
  get canRefresh(): boolean {
    return Boolean(this.auth.clientId);
  }

  /** A token that is not within {@link REFRESH_SKEW_MS} of expiry. `force` discards the cached one. */
  async get(force = false): Promise<string> {
    if (!this.auth.clientId) return this.auth.token!;
    const cur = this.#current;
    const fresh = cur && (cur.expiresAtMs === undefined || cur.expiresAtMs - REFRESH_SKEW_MS > this.#nowMs());
    if (!force && fresh) return cur.token;
    this.#pending ??= requestToken(this.auth.clientId, this.auth.clientSecret!, this.request).finally(() => {
      this.#pending = undefined;
    });
    this.#current = await this.#pending;
    return this.#current.token;
  }
}
