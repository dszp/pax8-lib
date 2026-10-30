import { describe, it, expect } from 'vitest';
import { Pax8ReadClient, WALK_PAGE_SIZE } from './readClient.js';
import { Pax8ApiError, IncompleteListError } from './errors.js';
import { backoffDelayMs, parseRetryAfter } from './http.js';
import { mockFetch, pagedHandler, TEST_BASE, TEST_CLIENT_ID, TEST_CLIENT_SECRET, TEST_TOKEN_URL, uuid, type MockFetch, type MockFetchOptions } from './testkit.js';
import * as barrel from './index.js';

function client(f: MockFetch, extra: { sleeps?: number[]; maxRetries?: number } = {}) {
  return new Pax8ReadClient({
    auth: { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET },
    baseUrl: TEST_BASE,
    tokenUrl: TEST_TOKEN_URL,
    fetchImpl: f.fetchImpl,
    retry: extra.maxRetries === undefined ? undefined : { maxRetries: extra.maxRetries },
    sleep: async (ms) => {
      extra.sleeps?.push(ms);
    },
    random: () => 0.5,
    nowMs: () => Date.parse('2026-01-01T00:00:00Z'),
  });
}

const subs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: uuid(i + 1), quantity: i, status: 'Active' }));

describe('Pax8ReadClient: reads', () => {
  it('maps list options to Pax8 query names and returns the page as sent', async () => {
    const f = mockFetch({ handler: pagedHandler('/subscriptions', subs(3)) });
    const page = await client(f).listSubscriptions({ companyId: uuid(9), status: 'Active', billingTerm: 'Annual', sort: 'startDate,desc', page: 0, size: 2 });
    expect(decodeURIComponent(f.apiCalls()[0]!.target)).toBe(
      `/subscriptions?companyId=${uuid(9)}&status=Active&billingTerm=Annual&sort=startDate,desc&page=0&size=2`,
    );
    expect(page.content).toHaveLength(2);
    expect(page.page).toEqual({ size: 2, totalElements: 3, totalPages: 2, number: 0 });
  });

  it('returns the content array for unpaged routes (history, pricing)', async () => {
    const id = uuid(1);
    const f = mockFetch({
      handler: (c) =>
        c.target === `/subscriptions/${id}/history`
          ? { body: { content: [{ id, quantity: 5 }, { id, quantity: 4 }] } }
          : c.target === `/products/${id}/pricing?companyId=${uuid(2)}`
            ? { body: { content: [{ billingTerm: 'Monthly', rates: [] }] } }
            : undefined,
    });
    const c = client(f);
    expect((await c.getSubscriptionHistory(id)).map((r) => r.quantity)).toEqual([5, 4]);
    expect(await c.getProductPricing(id, { companyId: uuid(2) })).toEqual([{ billingTerm: 'Monthly', rates: [] }]);
  });

  it('returns an empty history, not undefined, for an id Pax8 answers with {}', async () => {
    // Observed live: history requested by a currentSubscriptionId (not the lineage id) is `{}`.
    const f = mockFetch({ handler: () => ({ body: {} }) });
    expect(await client(f).getSubscriptionHistory(uuid(1))).toEqual([]);
  });

  it('refuses a non-UUID id before any request, in a path or a filter', async () => {
    const f = mockFetch();
    const c = client(f);
    await expect(c.getSubscription('../companies')).rejects.toThrow(TypeError);
    await expect(c.getCompany(42 as unknown as string)).rejects.toThrow(TypeError);
    await expect(c.listSubscriptions({ companyId: 'abc?x=1' })).rejects.toThrow(TypeError);
    expect(f.calls).toHaveLength(0);
  });

  it('rejects paging Pax8 would not accept', async () => {
    const f = mockFetch();
    const c = client(f);
    await expect(c.listCompanies({ size: 0 })).rejects.toThrow(RangeError);
    await expect(c.listCompanies({ size: 201 })).rejects.toThrow(RangeError);
    await expect(c.listCompanies({ page: -1 })).rejects.toThrow(RangeError);
    await expect(c.listDraftInvoiceItems({ monthOffset: 2 as 0 })).rejects.toThrow(RangeError);
    expect(f.calls).toHaveLength(0);
  });

  it('turns a Pax8 error body into a Pax8ApiError with its type', async () => {
    const f = mockFetch();
    const err = await client(f).getSubscription(uuid(1)).catch((e) => e);
    expect(err).toBeInstanceOf(Pax8ApiError);
    expect(err.isNotFound).toBe(true);
    expect(err.type).toBe('NOT_FOUND');
    expect(err.message).toBe(`Pax8 GET /subscriptions/${uuid(1)} -> 404: Not found.`);
  });
});

describe('Pax8ReadClient: walkers', () => {
  it('walks every page at the maximum size and checks the total', async () => {
    const rows = subs(WALK_PAGE_SIZE * 2 + 7);
    const f = mockFetch({ handler: pagedHandler('/subscriptions', rows) });
    const all = await client(f).listAllSubscriptions({ status: 'Active' });
    expect(all).toHaveLength(rows.length);
    expect(f.apiCalls().map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['0', '1', '2']);
    expect(f.apiCalls().every((c) => new URL(c.url).searchParams.get('size') === String(WALK_PAGE_SIZE))).toBe(true);
  });

  it('handles an empty collection in one request', async () => {
    const f = mockFetch({ handler: pagedHandler('/companies', []) });
    expect(await client(f).listAllCompanies()).toEqual([]);
    expect(f.apiCalls()).toHaveLength(1);
  });

  it('throws IncompleteListError when a row disappears mid-walk', async () => {
    const rows = subs(WALK_PAGE_SIZE + 5);
    const serve = pagedHandler('/subscriptions', rows);
    let calls = 0;
    const f = mockFetch({
      handler: (c) => {
        if (++calls === 2) rows.splice(0, 1); // a record removed after page 0 was read
        return serve(c);
      },
    });
    const err = await client(f).listAllSubscriptions().catch((e) => e);
    expect(err).toBeInstanceOf(IncompleteListError);
    expect(err.expected).toBe(WALK_PAGE_SIZE + 5);
  });

  it('throws IncompleteListError on a repeated id', async () => {
    const rows = subs(WALK_PAGE_SIZE + 1);
    rows[WALK_PAGE_SIZE] = { ...rows[0]! };
    const f = mockFetch({ handler: pagedHandler('/subscriptions', rows) });
    const err = await client(f).listAllSubscriptions().catch((e) => e);
    expect(err).toBeInstanceOf(IncompleteListError);
    expect(err.duplicates).toBe(1);
  });

  it('does not count rows without an id as duplicates', async () => {
    const rows = [{ quantity: 1 }, { quantity: 2 }];
    const f = mockFetch({ handler: pagedHandler(`/invoices/${uuid(1)}/items`, rows) });
    expect(await client(f).listAllInvoiceItems(uuid(1))).toHaveLength(2);
  });
});

describe('Pax8ReadClient: retries', () => {
  function flaky(statuses: Array<{ status: number; headers?: Record<string, string> }>): MockFetchOptions['handler'] {
    const queue = [...statuses];
    return () => queue.shift() ?? { body: { id: uuid(1) } };
  }

  it('retries a 429, waiting what Retry-After asks', async () => {
    const sleeps: number[] = [];
    const f = mockFetch({ handler: flaky([{ status: 429, headers: { 'retry-after': '3' } }, { status: 429, headers: { 'retry-after': '1' } }]) });
    expect(await client(f, { sleeps }).getCompany(uuid(1))).toEqual({ id: uuid(1) });
    expect(sleeps).toEqual([3000, 1000]);
    expect(f.apiCalls()).toHaveLength(3);
  });

  it('backs off exponentially with jitter when there is no Retry-After, and retries 503', async () => {
    const sleeps: number[] = [];
    const f = mockFetch({ handler: flaky([{ status: 429 }, { status: 503 }, { status: 429 }]) });
    await client(f, { sleeps }).getCompany(uuid(1));
    // random() = 0.5 → 3/4 of each doubling ceiling (1 s, 2 s, 4 s).
    expect(sleeps).toEqual([750, 1500, 3000]);
  });

  it('gives up after maxRetries with a 429 error carrying Retry-After', async () => {
    const f = mockFetch({ handler: () => ({ status: 429, headers: { 'retry-after': '7' }, body: { type: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded' } }) });
    const err = await client(f, { maxRetries: 2 }).getCompany(uuid(1)).catch((e) => e);
    expect(err).toBeInstanceOf(Pax8ApiError);
    expect(err.isRateLimited).toBe(true);
    expect(err.retryAfterSeconds).toBe(7);
    expect(err.message).toMatch(/after 2 retries/);
    expect(f.apiCalls()).toHaveLength(3);
  });

  it('does not retry other errors', async () => {
    const f = mockFetch({ handler: () => ({ status: 400, body: { type: 'BAD_REQUEST', message: 'bad' } }) });
    await expect(client(f).getCompany(uuid(1))).rejects.toThrow(/400: bad/);
    expect(f.apiCalls()).toHaveLength(1);
  });

  it('requests a new token once after a 401, then gives up', async () => {
    let valid = ['tok-2'];
    const f = mockFetch({ tokens: ['tok-1', 'tok-2'], validTokens: () => valid, handler: () => ({ body: { id: uuid(1) } }) });
    expect(await client(f).getCompany(uuid(1))).toEqual({ id: uuid(1) });
    expect(f.tokenRequests()).toBe(2);
    valid = [];
    const err = await client(f).getCompany(uuid(1)).catch((e) => e);
    expect(err.isUnauthorized).toBe(true);
    expect(err.message).toMatch(/rotated/);
  });

  it('parses Retry-After as seconds or an HTTP date, and caps the wait', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('12', now)).toBe(12);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(backoffDelayMs(0, 600, { baseDelayMs: 1000, maxDelayMs: 60_000, random: () => 0 })).toBe(60_000);
    expect(backoffDelayMs(10, undefined, { baseDelayMs: 1000, maxDelayMs: 60_000, random: () => 1 })).toBe(60_000);
  });

  it('refuses a non-HTTPS base URL and invalid retry settings', () => {
    const f = mockFetch();
    expect(() => new Pax8ReadClient({ auth: { token: 't' }, baseUrl: 'http://x.example', fetchImpl: f.fetchImpl })).toThrow(/HTTPS/);
    expect(() => new Pax8ReadClient({ auth: { token: 't' }, retry: { maxRetries: -1 }, fetchImpl: f.fetchImpl })).toThrow(RangeError);
  });
});

describe('read-only surface', () => {
  it('sends nothing but GET to the API', async () => {
    const f = mockFetch({ handler: pagedHandler('/companies', []) });
    await client(f).listAllCompanies();
    expect(f.apiCalls().every((c) => c.method === 'GET')).toBe(true);
  });

  it('exposes exactly these read methods', () => {
    const methods = Object.getOwnPropertyNames(Pax8ReadClient.prototype).filter((m) => m !== 'constructor').sort();
    expect(methods).toEqual(
      [
        'getCompany',
        'getCompanyContact',
        'getInvoice',
        'getOrder',
        'getProduct',
        'getProductDependencies',
        'getProductPricing',
        'getProductProvisionDetails',
        'getSubscription',
        'getSubscriptionHistory',
        'getUsageSummary',
        'listAllCompanies',
        'listAllCompanyContacts',
        'listAllDraftInvoiceItems',
        'listAllInvoiceItems',
        'listAllInvoices',
        'listAllOrders',
        'listAllProducts',
        'listAllSubscriptionUsageSummaries',
        'listAllSubscriptions',
        'listCompanies',
        'listCompanyContacts',
        'listDraftInvoiceItems',
        'listInvoiceItems',
        'listInvoices',
        'listOrders',
        'listProducts',
        'listSubscriptionUsageSummaries',
        'listSubscriptions',
        'listUsageLines',
      ].sort(),
    );
  });

  it('does not export the transport', () => {
    expect(Object.keys(barrel)).not.toContain('Pax8Http');
    expect(Object.keys(barrel)).not.toContain('errorFromResponse');
  });
});
