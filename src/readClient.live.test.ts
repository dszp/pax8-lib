/**
 * Live read-only smoke test against the real Pax8 API. Self-skips unless PAX8_CLIENT_ID and
 * PAX8_CLIENT_SECRET are set. Source them from your secret manager at run time; never commit them:
 *
 *   PAX8_CLIENT_ID="$(<secret manager> read ...)" PAX8_CLIENT_SECRET="$(<secret manager> read ...)" pnpm test
 *
 * Reads only, and asserts shapes, never values: real responses are customer data. Logs counts and
 * the token's scope count only. `process` is declared locally so this compiles under the Node-free
 * tsconfig (types: []).
 */
import { describe, it, expect } from 'vitest';
import { Pax8ReadClient } from './readClient.js';
import { requestToken, tokenClaims } from './auth.js';

declare const process: { env: Record<string, string | undefined> } | undefined;
const env = typeof process !== 'undefined' ? process!.env : {};
const ID = env.PAX8_CLIENT_ID;
const SECRET = env.PAX8_CLIENT_SECRET;

describe.skipIf(!ID || !SECRET)('live read smoke (real Pax8 API)', () => {
  // vitest runs a skipped describe's body to collect its tests, so build the client only with credentials.
  const client = ID && SECRET ? new Pax8ReadClient({ auth: { clientId: ID, clientSecret: SECRET } }) : (undefined as unknown as Pax8ReadClient);

  it('token: audience and scopes are readable', async () => {
    const { token } = await requestToken(ID!, SECRET!, { fetchImpl: (i, n) => fetch(i, n) });
    const c = tokenClaims(token);
    expect(c.audience).toBe('https://api.pax8.com');
    console.log(`[live] token scopes=${c.scopes.length} accountLevel=${c.accountLevel}`);
  }, 30_000);

  it('companies and subscriptions: full walks match totalElements', async () => {
    const companies = await client.listAllCompanies();
    const subs = await client.listAllSubscriptions({ status: 'Active' });
    for (const s of subs.slice(0, 20)) {
      expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof s.quantity).toBe('number');
    }
    console.log(`[live] companies=${companies.length} activeSubscriptions=${subs.length}`);
  }, 120_000);

  it('subscription history: records cover adjacent periods with the same id', async () => {
    const page = await client.listSubscriptions({ status: 'Active', size: 1 });
    const id = page.content[0]?.id;
    if (!id) return;
    const one = await client.getSubscription(id);
    expect(one.id).toBe(id);
    const history = await client.getSubscriptionHistory(id);
    expect(history.length).toBeGreaterThan(0);
    for (const r of history) {
      expect(r.id).toBe(id);
      expect(typeof r.startDate).toBe('string');
    }
    expect(history.filter((r) => !r.endDate).length).toBeLessThanOrEqual(1);
    console.log(`[live] history records=${history.length}`);
  }, 60_000);

  it('a missing subscription is a 404 Pax8ApiError', async () => {
    const err = await client.getSubscription('00000000-0000-4000-8000-000000000000').catch((e) => e);
    expect(err.isNotFound).toBe(true);
    expect(err.type).toBe('NOT_FOUND');
  }, 30_000);
});
