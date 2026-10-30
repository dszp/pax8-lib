/**
 * The Pax8 transport: URL building, bearer auth with one refresh-and-retry on 401, retry with
 * backoff on 429 and transient 5xx, and error normalisation.
 *
 * **Deliberately not exported from the package barrel.** The read-only guarantee of
 * {@link Pax8ReadClient} comes from that class having no mutating method, which only holds while
 * consumers cannot reach the raw transport underneath it. For the same reason this module has no
 * method other than GET. That is also what makes every retry here safe: a GET changes nothing.
 *
 * A write client, if one is added, gets its own transport in its own module and reuses
 * `TokenSource`, {@link errorFromResponse}, {@link backoffDelayMs} and {@link parseRetryAfter}. It must
 * not inherit this one's retry loop: a POST that timed out may already have placed an order.
 */
import { TokenSource, type Pax8Auth } from './auth.js';
import { Pax8ApiError } from './errors.js';

/** Pax8's production API root. Every route path is relative to it. */
export const DEFAULT_BASE_URL = 'https://api.pax8.com/v1';

/**
 * Pax8 allows 1000 successful calls per minute and answers 429 above that until the window resets.
 * The defaults retry for a little over a minute in total, so one full window can pass.
 */
export interface RetryOptions {
  /** Retries after the first attempt, for a 429 or a 502/503/504. Default 6. 0 disables. */
  maxRetries?: number;
  /** First backoff when the response has no `Retry-After`. Doubles each retry. Default 1000 ms. */
  baseDelayMs?: number;
  /** Upper bound for any single wait, including one Pax8 asked for. Default 60,000 ms. */
  maxDelayMs?: number;
}

export interface Pax8HttpConfig {
  auth: Pax8Auth;
  /** Defaults to production. Must be HTTPS. */
  baseUrl?: string;
  /** Defaults to Pax8's token endpoint. Must be HTTPS. */
  tokenUrl?: string;
  /** Defaults to `https://api.pax8.com`. */
  audience?: string;
  retry?: RetryOptions;
  /**
   * Injectable for tests or a host with its own HTTP primitive (an n8n node can adapt
   * `this.helpers.httpRequest` to this shape). Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch;
  /** Injectable clock in epoch ms, for token expiry and `Retry-After` dates. Defaults to `Date.now`. */
  nowMs?: () => number;
  /** Injectable wait, for tests. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0, 1). Defaults to `Math.random`. */
  random?: () => number;
}

/** Query values the transport serialises. `undefined` entries are dropped. */
export type Query = Record<string, string | number | boolean | undefined>;

const TRANSIENT = new Set([429, 502, 503, 504]);

/**
 * Seconds to wait from a `Retry-After` value: delay-seconds or an HTTP date. `undefined` when the
 * header is absent or unreadable.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/**
 * How long to wait before retry number `attempt` (0-based): what Pax8 asked for in `Retry-After`,
 * else exponential backoff with half jitter. Both are capped at `maxDelayMs`.
 *
 * Module-level rather than a method so a future write transport can share it.
 */
export function backoffDelayMs(
  attempt: number,
  retryAfterSeconds: number | undefined,
  o: { baseDelayMs: number; maxDelayMs: number; random: () => number },
): number {
  if (retryAfterSeconds !== undefined) return Math.min(retryAfterSeconds * 1000, o.maxDelayMs);
  const ceiling = Math.min(o.baseDelayMs * 2 ** attempt, o.maxDelayMs);
  return Math.floor(ceiling / 2 + (o.random() * ceiling) / 2);
}

/**
 * A {@link Pax8ApiError} for a failed response whose body text has already been read. Pax8 error
 * bodies are `{ type, message, instance, status, details }`; `message` becomes the detail.
 *
 * Module-level so a future write transport builds errors the same way.
 */
export function errorFromResponse(
  res: Response,
  method: string,
  path: string,
  text: string,
  ctx: { canRefresh: boolean; nowMs: number; note?: string },
): Pax8ApiError {
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : text;
  } catch {
    /* keep raw text */
  }
  const message = (body as { message?: unknown } | null)?.message;
  const detail =
    typeof message === 'string' ? message : typeof body === 'string' && body ? body.slice(0, 200) : res.statusText || 'request failed';
  const hint =
    res.status === 401
      ? ctx.canRefresh
        ? 'The token was rejected even after requesting a new one; the credential may have been rotated.'
        : 'The bearer token is invalid or expired. Pass { clientId, clientSecret } so the client can refresh it.'
      : ctx.note;
  return new Pax8ApiError(
    `Pax8 ${method} ${path} -> ${res.status}: ${detail}.${hint ? ` ${hint}` : ''}`,
    res.status,
    method,
    path,
    body,
    parseRetryAfter(res.headers.get('retry-after'), ctx.nowMs),
  );
}

export class Pax8Http {
  readonly #tokens: TokenSource;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #nowMs: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #maxRetries: number;
  readonly #backoff: { baseDelayMs: number; maxDelayMs: number; random: () => number };

  constructor(config: Pax8HttpConfig) {
    const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (!/^https:\/\//i.test(base)) throw new Error(`Pax8 baseUrl must be HTTPS, got: ${base}`);
    this.#baseUrl = base;
    // Bind: a bare global `fetch` called as a method of another object throws "Illegal invocation"
    // in Workers and browsers.
    this.#fetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#nowMs = config.nowMs ?? Date.now;
    this.#sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = config.random ?? Math.random;
    const r = config.retry ?? {};
    this.#maxRetries = r.maxRetries ?? 6;
    this.#backoff = { baseDelayMs: r.baseDelayMs ?? 1000, maxDelayMs: r.maxDelayMs ?? 60_000, random: this.#random };
    for (const [name, v] of [['maxRetries', this.#maxRetries], ['baseDelayMs', this.#backoff.baseDelayMs], ['maxDelayMs', this.#backoff.maxDelayMs]] as const) {
      if (!Number.isInteger(v) || v < 0) throw new RangeError(`Pax8 retry.${name} must be an integer >= 0, got ${v}`);
    }
    this.#tokens = new TokenSource(config.auth, {
      tokenUrl: config.tokenUrl,
      audience: config.audience,
      fetchImpl: this.#fetch,
      nowMs: this.#nowMs,
    });
  }

  /** Absolute URL for a path plus query, with `undefined` values dropped. */
  buildUrl(path: string, query?: Query): string {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async get<T>(path: string, query?: Query): Promise<T> {
    const url = this.buildUrl(path, query);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await this.#send(url, await this.#tokens.get());
      if (res.status === 401 && this.#tokens.canRefresh && !refreshed) {
        refreshed = true;
        await res.body?.cancel();
        // Not counted as a retry: the next request carries a new token, not the same one again.
        await this.#tokens.get(true);
        attempt--;
        continue;
      }
      if (TRANSIENT.has(res.status) && attempt < this.#maxRetries) {
        const asked = parseRetryAfter(res.headers.get('retry-after'), this.#nowMs());
        await res.body?.cancel();
        await this.#sleep(backoffDelayMs(attempt, asked, this.#backoff));
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        const note = res.status === 429 ? `Still rate limited after ${this.#maxRetries} retries (Pax8 allows 1000 calls per minute).` : undefined;
        throw errorFromResponse(res, 'GET', path, text, { canRefresh: this.#tokens.canRefresh, nowMs: this.#nowMs(), note });
      }
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  #send(url: string, token: string): Promise<Response> {
    return this.#fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
  }
}
