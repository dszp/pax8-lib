import { Pax8Http, type Pax8HttpConfig, type Query } from './http.js';
import { IncompleteListError } from './errors.js';
import type {
  Company,
  Contact,
  Dependencies,
  Invoice,
  InvoiceItem,
  ListCompaniesOptions,
  ListDraftInvoiceItemsOptions,
  ListInvoicesOptions,
  ListOrdersOptions,
  ListProductsOptions,
  ListSubscriptionsOptions,
  ListUsageLinesOptions,
  ListUsageSummariesOptions,
  Order,
  Page,
  PageOptions,
  Pax8Id,
  Pricing,
  Product,
  ProductDetail,
  ProvisioningDetail,
  Subscription,
  SubscriptionHistoryRecord,
  Unpaged,
  UsageLine,
  UsageSummary,
} from './model.js';

/** Page size the `listAll*` walkers request: Pax8's maximum. */
export const WALK_PAGE_SIZE = 200;

/** Runaway guard for the walkers: 500 pages × 200 rows = 100,000 records. */
const DEFAULT_MAX_PAGES = 500;

export interface WalkOptions {
  /** Override the runaway guard. */
  maxPages?: number;
}

export type Pax8ReadClientConfig = Pax8HttpConfig;

/** Filters for a walker: the list options without the paging ones, plus {@link WalkOptions}. */
type WalkFilters<O> = Omit<O, keyof PageOptions> & WalkOptions;

/**
 * Read-only client for the Pax8 Partner API. One method per GET endpoint, plus a `listAll*`
 * companion for each paged list that walks the whole collection and checks it against
 * `totalElements`.
 *
 * Pax8's create, update and delete endpoints are intentionally absent. If writes are added, they
 * belong in a separate write client with its own transport; this class will never gain a mutating
 * method.
 */
export class Pax8ReadClient {
  readonly #http: Pax8Http;

  constructor(config: Pax8ReadClientConfig) {
    this.#http = new Pax8Http(config);
  }

  // ---- companies --------------------------------------------------------------------------------

  async listCompanies(opts: ListCompaniesOptions = {}): Promise<Page<Company>> {
    const { page, size, ...filters } = opts;
    return this.#page<Company>('/companies', filters, { page, size });
  }

  async listAllCompanies(opts: WalkFilters<ListCompaniesOptions> = {}): Promise<Company[]> {
    const { maxPages, ...filters } = opts;
    return this.#walk<Company>('/companies', filters, maxPages);
  }

  async getCompany(companyId: Pax8Id): Promise<Company> {
    return this.#http.get<Company>(`/companies/${idSegment(companyId)}`);
  }

  async listCompanyContacts(companyId: Pax8Id, opts: PageOptions = {}): Promise<Page<Contact>> {
    return this.#page<Contact>(`/companies/${idSegment(companyId)}/contacts`, {}, opts);
  }

  async listAllCompanyContacts(companyId: Pax8Id, opts: WalkOptions = {}): Promise<Contact[]> {
    return this.#walk<Contact>(`/companies/${idSegment(companyId)}/contacts`, {}, opts.maxPages);
  }

  async getCompanyContact(companyId: Pax8Id, contactId: Pax8Id): Promise<Contact> {
    return this.#http.get<Contact>(`/companies/${idSegment(companyId)}/contacts/${idSegment(contactId)}`);
  }

  // ---- products ---------------------------------------------------------------------------------

  async listProducts(opts: ListProductsOptions = {}): Promise<Page<Product>> {
    const { page, size, ...filters } = opts;
    return this.#page<Product>('/products', filters, { page, size });
  }

  async listAllProducts(opts: WalkFilters<ListProductsOptions> = {}): Promise<Product[]> {
    const { maxPages, ...filters } = opts;
    return this.#walk<Product>('/products', filters, maxPages);
  }

  async getProduct(productId: Pax8Id): Promise<ProductDetail> {
    return this.#http.get<ProductDetail>(`/products/${idSegment(productId)}`);
  }

  /** The details an order for this product must supply. */
  async getProductProvisionDetails(productId: Pax8Id): Promise<ProvisioningDetail[]> {
    return this.#unpaged<ProvisioningDetail>(`/products/${idSegment(productId)}/provision-details`);
  }

  async getProductDependencies(productId: Pax8Id): Promise<Dependencies> {
    return this.#http.get<Dependencies>(`/products/${idSegment(productId)}/dependencies`);
  }

  /** Price rows per billing term and commitment. With `companyId`, that company's pricing. */
  async getProductPricing(productId: Pax8Id, opts: { companyId?: Pax8Id } = {}): Promise<Pricing[]> {
    const query = { companyId: opts.companyId === undefined ? undefined : idSegment(opts.companyId) };
    return this.#unpaged<Pricing>(`/products/${idSegment(productId)}/pricing`, query);
  }

  // ---- orders -----------------------------------------------------------------------------------

  async listOrders(opts: ListOrdersOptions = {}): Promise<Page<Order>> {
    const { page, size, ...filters } = opts;
    return this.#page<Order>('/orders', idFilters(filters, ['companyId']), { page, size });
  }

  async listAllOrders(opts: WalkFilters<ListOrdersOptions> = {}): Promise<Order[]> {
    const { maxPages, ...filters } = opts;
    return this.#walk<Order>('/orders', idFilters(filters, ['companyId']), maxPages);
  }

  async getOrder(orderId: Pax8Id): Promise<Order> {
    return this.#http.get<Order>(`/orders/${idSegment(orderId)}`);
  }

  // ---- subscriptions ----------------------------------------------------------------------------

  /** One entry per subscription lineage, under its original id. See {@link Subscription}. */
  async listSubscriptions(opts: ListSubscriptionsOptions = {}): Promise<Page<Subscription>> {
    const { page, size, ...filters } = opts;
    return this.#page<Subscription>('/subscriptions', idFilters(filters, ['companyId', 'productId']), { page, size });
  }

  async listAllSubscriptions(opts: WalkFilters<ListSubscriptionsOptions> = {}): Promise<Subscription[]> {
    const { maxPages, ...filters } = opts;
    return this.#walk<Subscription>('/subscriptions', idFilters(filters, ['companyId', 'productId']), maxPages);
  }

  async getSubscription(subscriptionId: Pax8Id): Promise<Subscription> {
    return this.#http.get<Subscription>(`/subscriptions/${idSegment(subscriptionId)}`);
  }

  /**
   * Every record of a subscription, as Pax8 returns them (newest first in testing). Not paged.
   * See {@link SubscriptionHistoryRecord} for what a record is and is not.
   *
   * Pass the lineage id (`id` from a list or a get), not `currentSubscriptionId`: Pax8 answers a
   * current id with an empty body, which this returns as `[]`.
   */
  async getSubscriptionHistory(subscriptionId: Pax8Id): Promise<SubscriptionHistoryRecord[]> {
    return this.#unpaged<SubscriptionHistoryRecord>(`/subscriptions/${idSegment(subscriptionId)}/history`);
  }

  // ---- invoices ---------------------------------------------------------------------------------

  async listInvoices(opts: ListInvoicesOptions = {}): Promise<Page<Invoice>> {
    const { page, size, ...filters } = opts;
    return this.#page<Invoice>('/invoices', idFilters(filters, ['companyId']), { page, size });
  }

  async listAllInvoices(opts: WalkFilters<ListInvoicesOptions> = {}): Promise<Invoice[]> {
    const { maxPages, ...filters } = opts;
    return this.#walk<Invoice>('/invoices', idFilters(filters, ['companyId']), maxPages);
  }

  async getInvoice(invoiceId: Pax8Id): Promise<Invoice> {
    return this.#http.get<Invoice>(`/invoices/${idSegment(invoiceId)}`);
  }

  async listInvoiceItems(invoiceId: Pax8Id, opts: PageOptions = {}): Promise<Page<InvoiceItem>> {
    return this.#page<InvoiceItem>(`/invoices/${idSegment(invoiceId)}/items`, {}, opts);
  }

  async listAllInvoiceItems(invoiceId: Pax8Id, opts: WalkOptions = {}): Promise<InvoiceItem[]> {
    return this.#walk<InvoiceItem>(`/invoices/${idSegment(invoiceId)}/items`, {}, opts.maxPages);
  }

  /** Items on the invoice still being built: this month's (`monthOffset` 0) or next month's (1). */
  async listDraftInvoiceItems(opts: ListDraftInvoiceItemsOptions = {}): Promise<Page<InvoiceItem>> {
    const { page, size, ...filters } = opts;
    return this.#page<InvoiceItem>('/invoices/draftItems', draftFilters(filters), { page, size });
  }

  async listAllDraftInvoiceItems(opts: WalkFilters<ListDraftInvoiceItemsOptions> = {}): Promise<InvoiceItem[]> {
    const { maxPages, ...filters } = opts;
    return this.#walk<InvoiceItem>('/invoices/draftItems', draftFilters(filters), maxPages);
  }

  // ---- usage ------------------------------------------------------------------------------------

  async listSubscriptionUsageSummaries(subscriptionId: Pax8Id, opts: ListUsageSummariesOptions = {}): Promise<Page<UsageSummary>> {
    const { page, size, ...filters } = opts;
    return this.#page<UsageSummary>(`/subscriptions/${idSegment(subscriptionId)}/usage-summaries`, idFilters(filters, ['companyId']), { page, size });
  }

  async listAllSubscriptionUsageSummaries(subscriptionId: Pax8Id, opts: WalkFilters<ListUsageSummariesOptions> = {}): Promise<UsageSummary[]> {
    const { maxPages, ...filters } = opts;
    return this.#walk<UsageSummary>(`/subscriptions/${idSegment(subscriptionId)}/usage-summaries`, idFilters(filters, ['companyId']), maxPages);
  }

  async getUsageSummary(usageSummaryId: Pax8Id): Promise<UsageSummary> {
    return this.#http.get<UsageSummary>(`/usage-summaries/${idSegment(usageSummaryId)}`);
  }

  async listUsageLines(usageSummaryId: Pax8Id, opts: ListUsageLinesOptions = {}): Promise<Page<UsageLine>> {
    const query = { usageDate: opts.usageDate, productId: opts.productId === undefined ? undefined : idSegment(opts.productId) };
    return this.#http.get<Page<UsageLine>>(`/usage-summaries/${idSegment(usageSummaryId)}/usage-lines`, query);
  }

  // ---- internals --------------------------------------------------------------------------------

  /** The `content` of a `{ content }` response; an empty body (`{}`) is an empty list. */
  async #unpaged<T>(path: string, query?: Query): Promise<T[]> {
    return (await this.#http.get<Partial<Unpaged<T>> | undefined>(path, query))?.content ?? [];
  }

  async #page<T>(path: string, filters: object, opts: PageOptions): Promise<Page<T>> {
    return this.#http.get<Page<T>>(path, { ...(filters as Query), ...pageQuery(opts) });
  }

  /**
   * Page walk at {@link WALK_PAGE_SIZE}. Stops at the first page's `totalPages`, then asserts the
   * row count against the FIRST page's `totalElements` (a page past the end reports 0) and that no
   * id appeared twice.
   */
  async #walk<T extends { id?: Pax8Id }>(path: string, filters: object, maxPages = DEFAULT_MAX_PAGES): Promise<T[]> {
    const out: T[] = [];
    let expected: number | undefined;
    let totalPages: number | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.#http.get<Page<T>>(path, { ...(filters as Query), page, size: WALK_PAGE_SIZE });
      expected ??= finiteOrThrow(path, 'totalElements', res.page?.totalElements);
      totalPages ??= finiteOrThrow(path, 'totalPages', res.page?.totalPages);
      out.push(...(res.content ?? []));
      if (page + 1 >= totalPages || (res.content ?? []).length === 0) {
        // Rows without an id (Pax8 omits empty fields) cannot be checked for repeats; skip them.
        const ids = out.map((row) => row.id).filter((id): id is Pax8Id => id !== undefined);
        const duplicates = ids.length - new Set(ids).size;
        if (out.length !== expected || duplicates > 0) {
          throw new IncompleteListError(path, expected, out.length, duplicates);
        }
        return out;
      }
    }
    throw new Error(`Pax8 ${path}: exceeded ${maxPages} pages; refusing to continue.`);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An id as a path segment or query value. Anything but a UUID is refused before a request is
 * made, so a caller's value can never change which route is called (`../`, `?`, `#`).
 */
function idSegment(id: Pax8Id): string {
  if (typeof id !== 'string' || !UUID.test(id)) {
    throw new TypeError(`Pax8 id must be a UUID string, got ${JSON.stringify(id)}`);
  }
  return id;
}

/** `filters` with the named id-valued keys checked by {@link idSegment}. */
function idFilters<O extends object>(filters: O, keys: Array<keyof O & string>): O {
  const out = { ...filters };
  for (const k of keys) {
    const v = out[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = idSegment(v as unknown as string);
  }
  return out;
}

function draftFilters(filters: Omit<ListDraftInvoiceItemsOptions, keyof PageOptions>): Query {
  const { monthOffset } = filters;
  if (monthOffset !== undefined && monthOffset !== 0 && monthOffset !== 1) {
    throw new RangeError(`monthOffset must be 0 or 1, got ${monthOffset}`);
  }
  return idFilters(filters, ['companyId']) as Query;
}

function pageQuery(opts: PageOptions): Query {
  const { page, size } = opts;
  if (page !== undefined && (!Number.isInteger(page) || page < 0)) {
    throw new RangeError(`page must be an integer >= 0, got ${page}`);
  }
  if (size !== undefined && (!Number.isInteger(size) || size < 1 || size > WALK_PAGE_SIZE)) {
    throw new RangeError(`size must be an integer from 1 to ${WALK_PAGE_SIZE}, got ${size}`);
  }
  return { page, size };
}

function finiteOrThrow(path: string, field: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`Pax8 ${path}: response is missing a numeric page.${field} (got ${JSON.stringify(v)}).`);
  }
  return v;
}
