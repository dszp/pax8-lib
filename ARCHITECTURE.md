# Architecture

This library is a small, dependency-free client that other code builds on: Workers, Node apps,
scripts, and possibly an n8n community node. This document explains how the modules divide the
work, and the reason for each boundary.

## Module boundaries

| Module | Responsibility | Exported |
|--------|----------------|----------|
| `auth.ts` | The client-credentials exchange, token expiry, `TokenSource` (cache, refresh, one shared request), `tokenClaims` | the exchange and claim helpers; `TokenSource` is internal |
| `errors.ts` | `Pax8ApiError`, `IncompleteListError` | yes |
| `http.ts` | URL building, bearer auth, retry after `401`, backoff on `429`/`502`/`503`/`504`, error normalisation | `DEFAULT_BASE_URL`, `parseRetryAfter`, `RetryOptions`; `Pax8Http` is private |
| `readClient.ts` | One method per GET route, the `listAll*` walkers, UUID checks on every id | yes |
| `model.ts` | Response and option types | types only |

`model.ts` doesn't depend on the transport, so code that receives Pax8 data some other way (a
webhook, a file) can type it without constructing a client.

## Read-only is enforced by what's reachable

`Pax8Http` has only a `get` method. The read client holds it in an ES `#private` field, and the
barrel doesn't export it, so neither TypeScript nor plain JavaScript code can send a mutating
request through this package. A test pins the read client's exact method list, and another
checks that every request it sends is a GET.

This matters because a Pax8 API credential isn't limited to reads, so the library is the layer
that makes a read-only consumer read-only.

## Adding a write client

Writes, if added, go in a new `Pax8WriteClient` backed by its own transport module. The pieces it
shares with reads are already module-level functions: `TokenSource` in `auth.ts`, and
`errorFromResponse`, `backoffDelayMs` and `parseRetryAfter` in `http.ts`. The write transport
must not copy the read transport's retry loop. Retrying is safe here only because a GET changes
nothing. A write that got a `502` or timed out may have happened, so the write client reports it
and leaves the decision to the caller. A `429` means the request was refused, so a write can be
retried after a `429` and nothing else.

## Authentication

`POST https://token-manager.pax8.com/oauth/token` with
`{ client_id, client_secret, audience: "https://api.pax8.com", grant_type: "client_credentials" }`
returns `{ access_token, token_type, expires_in, expires_at, scope }`. The token observed in
testing is a JWT that expires 24 hours after it's issued. `TokenSource` reads `exp` from the
token, falls back to `expires_in`, and refreshes five minutes early. Concurrent callers share one
token request. After a `401`, the client requests a new token and retries once.

## Rate limits and retries

Pax8 allows 1000 successful calls per minute and answers `429` above that until the window
resets. In testing, responses carried no rate-limit headers, so the client doesn't throttle ahead
of time; it reacts to `429`. It waits what `Retry-After` asks (seconds or an HTTP date) and
otherwise backs off exponentially from one second with half jitter, each wait capped at 60
seconds. The default of six retries spans more than one full window. The same applies to `502`,
`503` and `504`. Every other error is thrown at once.

## Pagination

Paged lists return `{ content, page: { size, totalElements, totalPages, number } }`, and `page` is
0-based. The maximum `size` is 200; the default is 10. The walkers request 200 rows per page and
stop at the first page's `totalPages`. They then check that the row count equals the first
page's `totalElements` and that no id appears twice.

The first page's totals are used because a page past the end reports `totalElements: 0`, not the
real total. Rows without an `id` are left out of the duplicate check, because Pax8 omits empty
fields.

Some routes (subscription history, product pricing, provisioning details) return
`{ content }` with no paging metadata. The client returns their `content` array.

## Subscription history

Every history record repeats the subscription's id, so the duplicate-id check doesn't apply to
history. The route isn't paged. Records are period snapshots rather than change events; see the
README.

## Reference

`reference/pax8-partner-endpoints.openapi.json` is Pax8's published OpenAPI document
(`https://devx.pax8.com/openapi/partner-endpoints.json`, fetched 2026-10-30). Where the live API
differs from it, the live API wins and `model.ts` says so.
