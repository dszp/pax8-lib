/** Errors the client throws. Kept in their own module so auth and transport can share them. */

/** An HTTP-level failure from the Pax8 API or its token endpoint. */
export class Pax8ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
    /** Path relative to the base URL (or the token URL's path), without the query string. */
    public readonly path: string,
    /** Parsed error body when the API sent one, else the raw text. */
    public readonly body: unknown,
    /**
     * Seconds Pax8 asked the caller to wait, from `Retry-After`, on a 429 that was still failing
     * after the transport's own retries.
     */
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'Pax8ApiError';
  }

  /** Pax8's own error code from the body (`NOT_FOUND`, `BAD_REQUEST`, ...), when present. */
  get type(): string | undefined {
    const t = (this.body as { type?: unknown } | null)?.type;
    return typeof t === 'string' ? t : undefined;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/**
 * Thrown by a full-collection walk whose rows do not add up to the `totalElements` the first page
 * reported, or that saw the same id twice. Pages are offset-based, so a record created or removed
 * mid-walk shifts later pages; re-run rather than trust the result.
 */
export class IncompleteListError extends Error {
  constructor(
    public readonly path: string,
    public readonly expected: number,
    public readonly received: number,
    public readonly duplicates: number = 0,
  ) {
    super(
      `Pax8 ${path}: walked ${received} rows (${duplicates} duplicate ids) but the first page reported ` +
        `totalElements=${expected}. The collection changed mid-walk; re-run rather than trust a partial list.`,
    );
    this.name = 'IncompleteListError';
  }
}
