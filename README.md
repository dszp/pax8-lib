# @dszp/pax8-lib

A read-only TypeScript client for the [Pax8](https://www.pax8.com) Partner API. It has no runtime
dependencies and no Node APIs, so the same code runs in a Cloudflare Worker, Node 20+, and the
browser.

The client handles four things you'd otherwise have to handle yourself:

- **Token lifecycle.** You pass a Pax8 API credential (client id and secret). The client requests
  a token with the client-credentials grant, caches the 24-hour token, refreshes it before it
  expires, and retries a `401` once with a new token. Concurrent calls share one token request.
- **Rate limits.** Pax8 allows 1000 calls per minute and answers `429` above that. The client
  waits for the time Pax8 asks for in `Retry-After`, or backs off exponentially when it doesn't
  say, and retries. It also retries `502`, `503` and `504`.
- **Complete lists.** The `listAll*` methods walk every page at Pax8's maximum page size of 200
  and check the result against the first page's `totalElements`. If the count doesn't match or
  an id repeats, the method throws.
- **Safe ids.** Every id is checked as a UUID before a request is made, so a value from a caller
  can't change which route is called.

This version reads only. Pax8's create, update and delete endpoints are intentionally absent.

## Install

```sh
pnpm add @dszp/pax8-lib
```

## Get an API credential

In Pax8, go to **Integrations > API credentials** and select **Create API credential**. Pax8
shows a client id and a client secret.

A Pax8 API credential can do more than read. This library sends only GET requests, but the
secret itself isn't limited to that. Store it in a secret manager or a Worker secret, give it to one
process only, and never commit it.

## Use it

```ts
import { Pax8ReadClient } from '@dszp/pax8-lib';

const pax8 = new Pax8ReadClient({
  auth: { clientId: env.PAX8_CLIENT_ID, clientSecret: env.PAX8_CLIENT_SECRET },
});

// One page, exactly as Pax8 returns it: { content, page: { size, totalElements, totalPages, number } }.
const { content, page } = await pax8.listCompanies({ size: 50 });

// Every active subscription. Throws IncompleteListError if the walk can't prove it got all of them.
const subs = await pax8.listAllSubscriptions({ status: 'Active' });

// The subscription's records over time.
const history = await pax8.getSubscriptionHistory(subs[0].id!);
```

In a Cloudflare Worker, set both values with `wrangler secret put`. If you create the client at
module scope, one token serves every request the isolate handles until the token nears expiry.

### Methods

| Resource | Methods |
|---|---|
| Companies | `listCompanies`, `listAllCompanies`, `getCompany`, `listCompanyContacts`, `listAllCompanyContacts`, `getCompanyContact` |
| Products | `listProducts`, `listAllProducts`, `getProduct`, `getProductPricing`, `getProductDependencies`, `getProductProvisionDetails` |
| Orders | `listOrders`, `listAllOrders`, `getOrder` |
| Subscriptions | `listSubscriptions`, `listAllSubscriptions`, `getSubscription`, `getSubscriptionHistory` |
| Invoices | `listInvoices`, `listAllInvoices`, `getInvoice`, `listInvoiceItems`, `listAllInvoiceItems`, `listDraftInvoiceItems`, `listAllDraftInvoiceItems` |
| Usage | `listSubscriptionUsageSummaries`, `listAllSubscriptionUsageSummaries`, `getUsageSummary`, `listUsageLines` |

The list methods take Pax8's own filter names, for example
`listSubscriptions({ companyId, productId, status, billingTerm, sort })`.

## Subscriptions and their history

`listSubscriptions` returns one entry per subscription *lineage*. The entry carries the lineage's
original `id` and shows its most recent record, whose own id is `currentSubscriptionId`.

`getSubscriptionHistory` returns the records behind it. Each record is the subscription as it
stood from `startDate` to `endDate`; the current record has no `endDate`. Records aren't change
events:

- Every record repeats the subscription's `id`.
- There is no action type and no quantity delta. A change is the difference between two adjacent
  records.
- A new record also starts at each billing-period boundary when nothing changed.

The live API returns the commitment as `commitment: { id, term, endDate }`. Pax8's OpenAPI document
calls it `commitmentTerm`. Both are typed.

## Dates

Dates are returned as the strings Pax8 sends. Timestamps use a `+0000` offset
(`2026-10-28T00:00:00.000+0000`), and date-only fields are `YYYY-MM-DD`.

## Errors

A failed request throws `Pax8ApiError`. It carries `status`, `method`, `path`, the parsed `body`,
Pax8's error code as `type` (for example `NOT_FOUND`), and `retryAfterSeconds` when a `429` is
still failing after the retries. A walk that can't prove completeness throws
`IncompleteListError`; re-run it.

## Options

```ts
new Pax8ReadClient({
  auth,                     // { clientId, clientSecret } or { token }
  retry: { maxRetries: 6, baseDelayMs: 1000, maxDelayMs: 60_000 },  // the defaults
  fetchImpl,                // a fetch-compatible function; defaults to the global fetch
});
```

To see which scopes a credential's token carries, decode it with `tokenClaims`. It returns the
scopes and the credential's name, and leaves out the token and the user ids:

```ts
import { requestToken, tokenClaims } from '@dszp/pax8-lib';
const { token } = await requestToken(id, secret, { fetchImpl: fetch });
console.log(tokenClaims(token).scopes);
```

If a token comes from somewhere else, pass `{ auth: { token } }`. The client uses it as-is and
can't refresh it, so every call fails with `401` once it expires.

## License

MIT
