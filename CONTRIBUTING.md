# Contributing to `@dszp/pax8-lib`

Bug reports, ideas, and pull requests are welcome. Each rule below prevents a specific failure.

## Getting started

This project uses pnpm and has no runtime dependencies. Keep it that way.

```sh
pnpm install
pnpm build         # tsc → dist/
pnpm test          # the offline suite; must pass with no credentials and no setup
pnpm typecheck     # also type-checks the tests and the mock-fetch harness
pnpm verify        # builds, then imports dist/index.js under Node
```

`pnpm test` must pass on a fresh clone with nothing configured. The live smoke test,
`src/readClient.live.test.ts`, runs only when `PAX8_CLIENT_ID` and `PAX8_CLIENT_SECRET` is set.

## The rules

### 1. Node-free, enforced by the compiler

`tsconfig.json` sets `"types": []`, and the project doesn't install `@types/node`. A `node:*`
import or a `Buffer` fails the build. Use `fetch`, `crypto.subtle`, `TextEncoder`, `atob`, and
`URL` instead. Don't add `@types/node` to make an error go away.

### 2. The transport stays private and GET-only

Don't export `Pax8Http` from `src/index.ts`, and never add a mutating method to `Pax8ReadClient`.
A Pax8 credential can place and cancel orders, so the guarantee that this package can't is only
as good as the transport being unreachable.

If write support is added, it goes in a separate `Pax8WriteClient` with its own transport module,
one endpoint at a time. That transport reuses `TokenSource`, `errorFromResponse`, `backoffDelayMs`
and `parseRetryAfter`, but not the read transport's retry loop. A GET can be repeated safely; a
POST that timed out may already have placed an order.

### 3. Ids are UUIDs, checked before a request

Every id that reaches a path or a query goes through `idSegment` in `readClient.ts`. Don't build a
path from an unchecked string.

### 4. Fixtures and examples are fictional

Every company, id, token, and secret in code, comments, tests, and docs must be invented. Use
`src/testkit.ts` as the model, and use `example.com` for hosts. Real Pax8 data doesn't belong
in the repository, commit messages, or issues. To describe a bug, describe the shape of the value,
not the value.

### 5. Completeness over convenience

If a walker can't prove it collected every record, it throws instead of returning a short list.
Keep the `totalElements` check, the duplicate-id check, and the runaway guard.

## Releasing

Every version on npm has a matching `vX.Y.Z` tag and GitHub Release. Publishing happens only in
CI: a published Release triggers `release-publish.yml`, which publishes to npm with provenance
through OIDC trusted publishing.

1. Bump `version` in `package.json` (`npm pkg set version=X.Y.Z`).
2. Move the Unreleased section of `CHANGELOG.md` under the new version.
3. Commit, and push `main`.
4. Tag the release commit `vX.Y.Z`, and push the tag.
5. Create a GitHub Release from that tag. For a prerelease version such as `X.Y.Z-rc.1`, mark it
   as a prerelease; the workflow publishes it under the `next` dist-tag.
6. Check that the workflow run succeeded and that `npm view @dszp/pax8-lib versions` lists
   the new version.

If npm already has the tagged version, the workflow finishes without publishing. The first
version of a new package was published by hand, because npm attaches a trusted publisher only to
a package that already exists.
