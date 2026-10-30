/**
 * Response and option types for the Pax8 Partner API.
 *
 * Field names follow Pax8's OpenAPI document (`reference/pax8-partner-endpoints.openapi.json`),
 * corrected where the live API differs. Every field is optional unless Pax8 marks it required,
 * because Pax8 omits empty fields rather than sending null. Transport-free, so a webhook receiver
 * can use these types without constructing a client.
 *
 * Dates are kept as the strings Pax8 sends. Timestamps carry a `+0000` offset
 * (`2026-10-28T00:00:00.000+0000`), not `Z`; date-only fields are `YYYY-MM-DD`.
 */

/** Pax8 ids are UUIDs, as strings. */
export type Pax8Id = string;

export type BillingTerm = 'Monthly' | 'Annual' | '2-Year' | '3-Year' | 'One-Time' | 'Trial' | 'Activation';

export type SubscriptionStatus =
  | 'Active'
  | 'Cancelled'
  | 'PendingManual'
  | 'PendingAutomated'
  | 'PendingCancel'
  | 'WaitingForDetails'
  | 'Trial'
  | 'Converted'
  | 'PendingActivation'
  | 'Activated';

export type CompanyStatus = 'Active' | 'Inactive' | 'Deleted';

/** Paging metadata on every list response. `number` is the 0-based page index. */
export interface PageInfo {
  size: number;
  totalElements: number;
  totalPages: number;
  number: number;
}

/** One page of a list, exactly as Pax8 returns it. */
export interface Page<T> {
  content: T[];
  page: PageInfo;
}

/** A list Pax8 returns whole, without paging metadata. */
export interface Unpaged<T> {
  content: T[];
}

/** Paging options for any list method. Pax8's default size is 10; the maximum is 200. */
export interface PageOptions {
  /** 0-based page index. */
  page?: number;
  /** 1..200. */
  size?: number;
}

/** Pax8's error body. */
export interface Pax8ErrorBody {
  type?: string;
  message?: string;
  instance?: string;
  status?: number;
  details?: Array<{ type?: string; message?: string; instance?: string; status?: number }>;
}

// ---- companies ----------------------------------------------------------------------------------

export interface Address {
  street?: string;
  street2?: string;
  city?: string;
  stateOrProvince?: string;
  postalCode?: string;
  country?: string;
}

export interface ContactType {
  type?: 'Admin' | 'Billing' | 'Technical';
  primary?: boolean;
}

export interface Contact {
  id?: Pax8Id;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  createdDate?: string;
  types?: ContactType[];
}

export interface Company {
  id?: Pax8Id;
  name: string;
  address: Address;
  phone: string;
  website: string;
  /** The partner's own id for the company, when one was set (for example a PSA account id). */
  externalId?: string;
  billOnBehalfOfEnabled: boolean;
  selfServiceAllowed: boolean;
  orderApprovalRequired: boolean;
  status?: CompanyStatus;
  updatedDate?: string;
  contacts?: Contact[];
}

export interface ListCompaniesOptions extends PageOptions {
  sort?: 'name' | 'city' | 'country' | 'stateOrProvince' | 'postalCode';
  city?: string;
  country?: string;
  stateOrProvince?: string;
  postalCode?: string;
  selfServiceAllowed?: boolean;
  billOnBehalfOfEnabled?: boolean;
  orderApprovalRequired?: boolean;
  status?: CompanyStatus;
}

// ---- products -----------------------------------------------------------------------------------

export interface Product {
  id?: Pax8Id;
  name?: string;
  vendorName?: string;
  shortDescription?: string;
  sku?: string;
  vendorSku?: string;
  altVendorSku?: string;
  requiresCommitment?: boolean;
}

export interface ProductDetail extends Product {
  description?: string;
}

export interface ListProductsOptions extends PageOptions {
  sort?: 'name' | 'vendor';
  search?: string;
  vendorName?: string;
}

export interface Rate {
  partnerBuyRate?: number;
  suggestedRetailPrice?: number;
  startQuantityRange?: number;
  endQuantityRange?: number;
  chargeType?: 'Per Unit' | 'Flat Rate';
}

export interface Pricing {
  productId?: Pax8Id;
  productName?: string;
  billingTerm?: BillingTerm;
  commitmentTerm?: string;
  commitmentTermInMonths?: number;
  type?: 'Flat' | 'Volume' | 'Tiered' | 'Mark-Up';
  unitOfMeasurement?: string;
  rates?: Rate[];
}

/** The terms a commitment-based product can be bought on. */
export interface Commitment {
  id?: Pax8Id;
  term?: string;
  autoRenew?: boolean;
  renewalWindowDaysBeforeTermEnd?: number;
  renewalWindowDaysAfterTermEnd?: number;
  allowForQuantityIncrease?: boolean;
  allowForQuantityDecrease?: boolean;
  allowForEarlyCancellation?: boolean;
  cancellationFeeApplied?: boolean;
  isTransferable?: boolean;
}

export interface ProductDependency {
  name?: string;
  products?: Product[];
}

export interface Dependencies {
  commitmentDependencies?: Commitment[];
  productDependencies?: ProductDependency[];
}

export interface ProvisioningDetail {
  label?: string;
  key?: string;
  description?: string;
  valueType?: string;
  possibleValues?: string[];
  [key: string]: unknown;
}

// ---- subscriptions ------------------------------------------------------------------------------

/** The commitment a subscription is on, with the date its term ends. */
export interface SubscriptionCommitment {
  id?: Pax8Id;
  term?: string;
  endDate?: string;
}

/**
 * A subscription.
 *
 * In a list, each entry is one subscription *lineage*: it carries the lineage's original `id` and
 * reflects the most recent record, whose own id is `currentSubscriptionId`. A subscription that was
 * modified appears once, not once per change. {@link Pax8ReadClient.getSubscriptionHistory} returns
 * the individual records.
 */
export interface Subscription {
  id?: Pax8Id;
  parentSubscriptionId?: Pax8Id;
  currentSubscriptionId?: Pax8Id;
  companyId?: Pax8Id;
  productId?: Pax8Id;
  productName?: string;
  /** The vendor's own id for the subscription (for Microsoft, the subscription id in the tenant). */
  vendorSubscriptionId?: string;
  /** The vendor's SKU id. Returned by the single-subscription route. */
  vendorSkuId?: string;
  quantity?: number;
  startDate?: string;
  endDate?: string;
  createdDate?: string;
  updatedDate?: string;
  billingStart?: string;
  status?: SubscriptionStatus;
  price?: number;
  partnerCost?: number;
  currencyCode?: string;
  billingTerm?: BillingTerm;
  /** Returned by the live API; the OpenAPI document names it `commitmentTerm`. */
  commitment?: SubscriptionCommitment;
  commitmentTerm?: SubscriptionCommitment;
  provisioningDetails?: ProvisioningDetail[];
  usageEligible?: boolean;
}

/**
 * One record in a subscription's history: the subscription as it stood from `startDate` to
 * `endDate`. The current record has no `endDate`.
 *
 * Every record repeats the subscription's id, so the id does not identify a record. Records are
 * not change events: there is no action type and no quantity delta, so a change is the difference
 * between adjacent records. A new record also starts at each billing-period boundary even when
 * nothing changed.
 */
export type SubscriptionHistoryRecord = Subscription;

export interface ListSubscriptionsOptions extends PageOptions {
  sort?:
    | 'quantity,asc'
    | 'quantity,desc'
    | 'startDate,asc'
    | 'startDate,desc'
    | 'endDate,asc'
    | 'endDate,desc'
    | 'createdDate,asc'
    | 'createdDate,desc'
    | 'billingStart,asc'
    | 'billingStart,desc'
    | 'price,asc'
    | 'price,desc';
  status?: SubscriptionStatus;
  billingTerm?: BillingTerm;
  companyId?: Pax8Id;
  productId?: Pax8Id;
}

// ---- orders -------------------------------------------------------------------------------------

export interface LineItem {
  id?: Pax8Id;
  productId: Pax8Id;
  subscriptionId?: Pax8Id;
  commitmentTermId?: Pax8Id;
  provisionStartDate?: string;
  lineItemNumber: number;
  billingTerm?: BillingTerm;
  parentSubscriptionId?: Pax8Id;
  parentLineItemNumber?: number;
  quantity: number;
  provisioningDetails?: ProvisioningDetail[];
}

export interface Order {
  id?: Pax8Id;
  companyId: Pax8Id;
  createdDate?: string;
  orderedBy?: 'Pax8 Partner' | 'Customer' | 'Pax8';
  orderedByUserId?: Pax8Id;
  orderedByUserEmail?: string;
  isScheduled?: boolean;
  lineItems: LineItem[];
}

export interface ListOrdersOptions extends PageOptions {
  companyId?: Pax8Id;
}

// ---- invoices -----------------------------------------------------------------------------------

export interface Invoice {
  id?: Pax8Id;
  invoiceDate?: string;
  dueDate?: string;
  balance?: number;
  carriedBalance?: number;
  total?: number;
  currencyCode?: string;
  partnerName?: string;
  companyId?: Pax8Id;
  externalId?: string;
}

export type InvoiceStatus = 'Unpaid' | 'Paid' | 'Void' | 'Carried' | 'Nothing Due' | 'Credited';

export interface ListInvoicesOptions extends PageOptions {
  sort?: 'invoiceDate' | 'dueDate' | 'status' | 'partnerName' | 'total' | 'balance' | 'carriedBalance';
  status?: InvoiceStatus;
  /** `YYYY-MM-DD`. */
  invoiceDate?: string;
  invoiceDateRangeStart?: string;
  invoiceDateRangeEnd?: string;
  dueDate?: string;
  total?: number;
  balance?: number;
  carriedBalance?: number;
  companyId?: Pax8Id;
}

export interface InvoiceItem {
  id?: Pax8Id;
  purchaseOrderNumber?: string;
  type?: 'rebate' | 'prorate' | 'subscription' | 'payment-credit' | 'one-time' | 'service-charge' | 'service-credit' | 'invoice-credit';
  companyId?: Pax8Id;
  externalId?: string;
  companyName?: string;
  startPeriod?: string;
  endPeriod?: string;
  quantity?: number;
  unitOfMeasure?: string;
  term?: string;
  sku?: string;
  description?: string;
  details?: string;
  rateType?: string;
  chargeType?: 'flat' | 'per';
  price?: number;
  subTotal?: number;
  cost?: number;
  costTotal?: number;
  offeredBy?: string;
  billedByPax8?: boolean;
  total?: number;
  productId?: Pax8Id;
  productName?: string;
  billingFee?: number;
  billingFeeRate?: number;
  amountDue?: number;
  currencyCode?: string;
  salesTax?: number;
  subscriptionId?: Pax8Id;
  vendorName?: string;
}

export interface ListDraftInvoiceItemsOptions extends PageOptions {
  /** 0 = the current month's draft, 1 = next month's. */
  monthOffset?: 0 | 1;
  companyId?: Pax8Id;
}

// ---- usage --------------------------------------------------------------------------------------

export interface UsageSummary {
  id?: Pax8Id;
  companyId?: Pax8Id;
  productId?: Pax8Id;
  resourceGroup?: string;
  vendorName?: string;
  currentCharges?: number;
  currencyCode?: string;
  partnerTotal?: number;
  isTrial?: boolean;
}

export interface UsageLine {
  usageSummaryId?: Pax8Id;
  usageDate?: string;
  productName?: string;
  productId?: Pax8Id;
  unitOfMeasure?: string;
  quantity?: number;
  currentCharges?: number;
  currentProfit?: number;
  partnerTotal?: number;
  unitPrice?: number;
  currencyCode?: string;
  isTrial?: boolean;
}

export interface ListUsageSummariesOptions extends PageOptions {
  sort?: 'resourceGroup,asc' | 'resourceGroup,desc';
  resourceGroup?: string;
  companyId?: Pax8Id;
}

export interface ListUsageLinesOptions {
  /** `YYYY-MM-DD`. */
  usageDate?: string;
  productId?: Pax8Id;
}
