# Changelog

All notable changes to `@dszp/pax8-lib` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-10-30

### Added

- `Pax8ReadClient`, with one method for each GET route of the Partner API: companies and contacts,
  products (pricing, dependencies, provisioning details), orders, subscriptions and subscription
  history, invoices and invoice items, draft invoice items, and usage summaries and lines.
- `listAll*` walkers, checked against `totalElements` and for repeated ids.
- Client-credentials token handling: caching, early refresh, one shared request, and one retry
  after a `401`.
- Retry with backoff on `429` (`Retry-After` honoured) and on `502`, `503` and `504`.
- `tokenClaims` for auditing what a credential's token is allowed to do.
