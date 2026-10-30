import { describe, it, expect } from 'vitest';
import { REFRESH_SKEW_MS, TokenSource, requestToken, tokenClaims } from './auth.js';
import { Pax8ApiError } from './errors.js';
import { fakeJwt, mockFetch, TEST_CLIENT_ID, TEST_CLIENT_SECRET, TEST_TOKEN_URL } from './testkit.js';

const creds = { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET };

describe('requestToken', () => {
  it('sends the client-credentials body with the API audience', async () => {
    const f = mockFetch();
    await requestToken(TEST_CLIENT_ID, TEST_CLIENT_SECRET, { tokenUrl: TEST_TOKEN_URL, fetchImpl: f.fetchImpl });
    const body = JSON.parse(f.calls[0]!.body!);
    expect(body).toEqual({ client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET, audience: 'https://api.pax8.com', grant_type: 'client_credentials' });
    expect(f.calls[0]!.method).toBe('POST');
  });

  it('takes expiry from the JWT exp claim, else from expires_in', async () => {
    const jwt = fakeJwt({ exp: 2_000_000 });
    const withExp = await requestToken(TEST_CLIENT_ID, TEST_CLIENT_SECRET, {
      tokenUrl: TEST_TOKEN_URL,
      fetchImpl: mockFetch({ tokens: [jwt] }).fetchImpl,
      nowMs: () => 0,
    });
    expect(withExp.expiresAtMs).toBe(2_000_000_000);
    const opaque = await requestToken(TEST_CLIENT_ID, TEST_CLIENT_SECRET, {
      tokenUrl: TEST_TOKEN_URL,
      fetchImpl: mockFetch({ tokens: ['opaque'], expiresIn: 100 }).fetchImpl,
      nowMs: () => 5_000,
    });
    expect(opaque.expiresAtMs).toBe(105_000);
  });

  it('reports a rejected credential without echoing the secret', async () => {
    const f = mockFetch();
    const err = await requestToken(TEST_CLIENT_ID, 'wrong', { tokenUrl: TEST_TOKEN_URL, fetchImpl: f.fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(Pax8ApiError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/access_denied: Unauthorized.*rotated/);
    expect(err.message).not.toContain('wrong');
  });

  it('refuses a non-HTTPS token URL and empty credentials before any request', async () => {
    const f = mockFetch();
    await expect(requestToken(TEST_CLIENT_ID, TEST_CLIENT_SECRET, { tokenUrl: 'http://x.example/t', fetchImpl: f.fetchImpl })).rejects.toThrow(/HTTPS/);
    await expect(requestToken('', TEST_CLIENT_SECRET, { fetchImpl: f.fetchImpl })).rejects.toThrow(/required/);
    expect(f.calls).toHaveLength(0);
  });
});

describe('TokenSource', () => {
  it('shares one in-flight request among concurrent callers and caches the token', async () => {
    const f = mockFetch();
    const src = new TokenSource(creds, { tokenUrl: TEST_TOKEN_URL, fetchImpl: f.fetchImpl });
    const got = await Promise.all([src.get(), src.get(), src.get()]);
    expect(got).toEqual(['tok-1', 'tok-1', 'tok-1']);
    await src.get();
    expect(f.tokenRequests()).toBe(1);
  });

  it('refreshes inside the skew window before expiry, and on force', async () => {
    let now = 0;
    const exp = 10_000; // seconds
    const f = mockFetch({ tokens: [fakeJwt({ exp }), fakeJwt({ exp: exp * 2 }), fakeJwt({ exp: exp * 3 })] });
    const src = new TokenSource(creds, { tokenUrl: TEST_TOKEN_URL, fetchImpl: f.fetchImpl, nowMs: () => now });
    await src.get();
    now = exp * 1000 - REFRESH_SKEW_MS - 1;
    await src.get();
    expect(f.tokenRequests()).toBe(1);
    now = exp * 1000 - REFRESH_SKEW_MS + 1;
    await src.get();
    expect(f.tokenRequests()).toBe(2);
    await src.get(true);
    expect(f.tokenRequests()).toBe(3);
  });

  it('uses a supplied token as-is and never refreshes it', async () => {
    const f = mockFetch();
    const src = new TokenSource({ token: 'given' }, { fetchImpl: f.fetchImpl });
    expect(await src.get(true)).toBe('given');
    expect(src.canRefresh).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});

describe('tokenClaims', () => {
  it('returns scopes and labels but none of the identifying claims', () => {
    const jwt = fakeJwt({
      scope: 'order_writer product_reader',
      aud: 'https://api.pax8.com',
      iss: 'https://issuer.example/',
      exp: 100,
      sub: 'secret-sub@clients',
      azp: 'client-id',
      clientMetadata: { applicationName: 'clientcredentials_Test', accountLevel: 'PARTNER', id: 'user-id', entityId: 'entity-id' },
    });
    const c = tokenClaims(jwt);
    expect(c).toEqual({
      scopes: ['order_writer', 'product_reader'],
      audience: 'https://api.pax8.com',
      issuer: 'https://issuer.example/',
      expiresAtMs: 100_000,
      applicationName: 'clientcredentials_Test',
      accountLevel: 'PARTNER',
    });
    expect(JSON.stringify(c)).not.toMatch(/secret-sub|client-id|user-id|entity-id/);
  });

  it('is empty, not a throw, for an unreadable token', () => {
    expect(tokenClaims('not-a-jwt')).toEqual({ scopes: [], audience: undefined, issuer: undefined, expiresAtMs: undefined, applicationName: undefined, accountLevel: undefined });
  });
});
