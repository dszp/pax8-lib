/**
 * Shared test helpers: a recording mock `fetch` that speaks Pax8's shapes, including the
 * client-credentials exchange and `{ content, page }` lists.
 *
 * Build-excluded and never exported from the barrel, but type-checked by `tsconfig.test.json`.
 * Node-free like the rest of the source. Every value here is fictional.
 */

export interface RecordedCall {
  method: string;
  url: string;
  /** Path + query relative to the API root, for terse assertions. */
  target: string;
  headers: Record<string, string>;
  body?: string;
}

export interface MockResponse {
  status?: number;
  /** JSON body, serialised with `JSON.stringify`. */
  body?: unknown;
  /** Exact body text, for non-JSON errors. */
  rawBody?: string;
  headers?: Record<string, string>;
}

export interface MockFetchOptions {
  /** Answer for a non-token call. */
  handler?: (call: RecordedCall) => MockResponse | undefined;
  /** Tokens handed out by successive exchanges. Defaults to one token. */
  tokens?: string[];
  /** Tokens the API accepts. Defaults to every token in `tokens`. */
  validTokens?: () => string[];
  /** `expires_in` the token endpoint reports. Default 86400. */
  expiresIn?: number;
}

export interface MockFetch {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
  /** Calls excluding the token exchange. */
  apiCalls: () => RecordedCall[];
  tokenRequests: () => number;
}

export const TEST_CLIENT_ID = 'test-client-id-not-real';
export const TEST_CLIENT_SECRET = 'test-client-secret-not-real';
export const TEST_BASE = 'https://pax8.example.com/v1';
export const TEST_TOKEN_URL = 'https://auth.pax8.example.com/oauth/token';

/** A syntactically valid unsigned JWT with the given claims. */
export function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

function toResponse(spec: MockResponse): Response {
  const status = spec.status ?? 200;
  const text = spec.rawBody ?? (spec.body === undefined ? '' : JSON.stringify(spec.body));
  return new Response(status === 204 ? null : text, {
    status,
    headers: { 'content-type': 'application/json', ...(spec.headers ?? {}) },
  });
}

export function mockFetch(opts: MockFetchOptions = {}): MockFetch {
  const calls: RecordedCall[] = [];
  const tokens = [...(opts.tokens ?? ['tok-1'])];
  const issued: string[] = [];
  const valid = opts.validTokens ?? (() => opts.tokens ?? ['tok-1']);

  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = String(input);
    const u = new URL(url);
    const call: RecordedCall = {
      method: init.method ?? 'GET',
      url,
      target: u.origin === new URL(TEST_BASE).origin ? u.pathname.replace(/^\/v1/, '') + u.search : url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
    };
    calls.push(call);

    if (url === TEST_TOKEN_URL) {
      const b = JSON.parse(call.body ?? '{}') as { client_id?: string; client_secret?: string };
      if (b.client_id !== TEST_CLIENT_ID || b.client_secret !== TEST_CLIENT_SECRET) {
        return toResponse({ status: 401, body: { error: 'access_denied', error_description: 'Unauthorized' } });
      }
      const token = tokens.shift() ?? issued[issued.length - 1] ?? 'tok-1';
      issued.push(token);
      return toResponse({ body: { access_token: token, token_type: 'Bearer', expires_in: opts.expiresIn ?? 86400 } });
    }

    const auth = call.headers.Authorization ?? '';
    if (!valid().includes(auth.replace(/^Bearer /, ''))) {
      return toResponse({ status: 401, body: { type: 'UNAUTHORIZED', message: 'Unauthorized', status: 401 } });
    }
    return toResponse(opts.handler?.(call) ?? { status: 404, body: { type: 'NOT_FOUND', message: 'Not found', status: 404, details: [] } });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    calls,
    apiCalls: () => calls.filter((c) => c.url !== TEST_TOKEN_URL),
    tokenRequests: () => calls.filter((c) => c.url === TEST_TOKEN_URL).length,
  };
}

/** Deterministic fictional UUIDs. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/**
 * Serve a paged list the way Pax8 does: `{ content, page }`, `page` 0-based, and a page past the
 * end reporting `totalElements: 0` (observed live).
 */
export function pagedHandler(path: string, rows: Array<Record<string, unknown>>) {
  return (call: RecordedCall): MockResponse | undefined => {
    const u = new URL(call.url);
    if (u.pathname.replace(/^\/v1/, '') !== path) return undefined;
    const size = Number(u.searchParams.get('size') ?? 10);
    const page = Number(u.searchParams.get('page') ?? 0);
    const totalPages = Math.ceil(rows.length / size);
    if (page >= totalPages && rows.length) {
      return { body: { content: [], page: { size, totalElements: 0, totalPages: 0, number: page } } };
    }
    return {
      body: {
        content: rows.slice(page * size, page * size + size),
        page: { size, totalElements: rows.length, totalPages, number: page },
      },
    };
  };
}
