export { landedCostReceiptClearingCsv } from "../../shared/landed-cost-receipt-clearing-csv";

export type ProductStatus = "draft" | "active" | "inactive";
export type CategoryStatus = "active" | "inactive";
export type SupplierStatus = "active" | "inactive";
export type SupplierQuoteStatus = "received" | "accepted" | "rejected";
export type PurchaseOrderStatus = "ordered" | "partially_received" | "received" | "cancelled";
export type ShipmentStatus = "in_transit" | "partially_received" | "received" | "cancelled";
export type AllocationBasis = "value" | "quantity";

export interface PurchaseOrderLine {
  id: number; productId: number; productName: string; sku: string; quantityOrdered: number; unitPrice: string;
}
export interface PurchaseOrder {
  id: number; orderNumber: string; supplierId: number; supplierName: string; status: PurchaseOrderStatus;
  currency: string; exchangeRateToZmw: string; orderedAt: string; expectedAt: string | null; notes: string | null;
  lines: PurchaseOrderLine[];
}
export interface ShipmentLine {
  id: number; purchaseOrderLineId: number; productName: string; sku: string; orderNumber: string; supplierName: string; quantityShipped: number;
  quantityReceived: number; quantityOrdered: number;
}
export interface Shipment {
  id: number; purchaseOrderId: number; orderNumber: string; supplierName: string; orderNumbers: string[]; supplierNames: string[]; shipmentReference: string | null;
  carrier: string | null; trackingNumber: string | null; status: ShipmentStatus; shippedAt: string | null;
  expectedAt: string | null; lines: ShipmentLine[];
}
export interface ImportExpense {
  id: number; purchaseOrderId: number | null; shipmentId: number | null; category: string; description: string; amount: string; currency: string;
  exchangeRateToZmw: string; basis: AllocationBasis; incurredAt: string; reference: string | null;
}
export interface LandedCostOrder extends PurchaseOrder {
  allocations: { expenseId: number; lineId: number; amountZmw: string }[];
  lines: (PurchaseOrderLine & { allocatedExpensesZmw: string; purchaseUnitCostZmw: string; landedUnitCostZmw: string })[];
  adjustmentPreview: {
    allocatedExpensesZmw: string;
    receiptClearedTotalZmw: string;
    priorAdjustmentsClearedZmw: string;
    clearingBalanceZmw: string;
    adjustmentAvailableZmw: string;
    unpostedClearingZmw: string;
    canPost: boolean;
    hasNegativeLine: boolean;
    receipts: {
      journalEntryId: number; entryNumber: string; entryDate: string; memo: string;
      shipmentReference: string | null; productName: string; sku: string; quantity: number;
      clearedAmountZmw: string;
    }[];
    adjustments: {
      journalEntryId: number; entryNumber: string; entryDate: string; memo: string;
    }[];
    lines: {
      lineId: number; productId: number; productName: string; stockedQuantity: number; onHand: number;
      averageUnitCostZmw: string; adjustmentZmw: string; inventoryZmw: string; cogsZmw: string;
    }[];
  } | null;
}
export interface AccountingJournalEntry {
  id: number;
  entryNumber: string;
  memo: string;
  entryDate: string;
  sourceType: string;
  lines: Array<{
    accountCode: string;
    accountName: string;
    debitZmw: string;
    creditZmw: string;
    description: string | null;
  }>;
}
export interface InventoryItem {
  id: number; name: string; sku: string; unit: string; status: ProductStatus; onHand: number; reserved: number; available: number;
  stockValueZmw: string; averageUnitCostZmw: string;
  locations: { id: number | null; name: string; onHand: number; reserved: number; available: number; stockValueZmw: string }[];
}
export interface InventoryLocationTotal {
  id: number | null; name: string; onHand: number; reserved: number; available: number; stockValueZmw: string;
}
export interface InventoryMovementEvidence { id: number | null; fileName: string; mimeType: string; }
export interface InventoryMovement { id: number; productId: number; productName: string; sku: string; kind: string; quantityDelta: number; reason: string; reference: string | null; locationId: number | null; locationName: string | null; salesDeliveryLineId: number | null; correctionOfMovementId: number | null; createdAt: string; evidenceFiles: InventoryMovementEvidence[]; }
export interface InventoryLocation { id: number; name: string; active: boolean; }
export interface InventoryReservation { id: number; productId: number; productName: string; sku: string; quantity: number; status: "active" | "released" | "fulfilled"; reference: string | null; reason: string; salesOrderId: number | null; locationName: string | null; createdAt: string; }
export interface InventoryReceipt { id: number; quantityToPost: number; quantityReceived: number; quantityStocked: number; shipmentReference: string | null; orderNumber: string; supplierName: string; productName: string; sku: string; }
export interface UnlinkedReceiptJournal {
  id: number; entryNumber: string; entryDate: string; memo: string; sourceId: number | null;
  movementId: number | null; movementSourceKey: string | null; movementProductId: number | null;
  movementQuantity: number | null; movementReason: string | null; movementReference: string | null;
  movementCreatedAt: string | null; productName: string | null; sku: string | null;
  candidates: {
    productId: number; shipmentLineId: number; shipmentId: number; shipmentReference: string | null;
    shipmentStatus: string; receivedAt: string | null; orderNumber: string; supplierName: string;
    productName: string; sku: string; quantityReceived: number; quantityStocked: number;
  }[];
}
export interface Customer { id: number; name: string; contactPerson: string | null; contactPersonPhone: string | null; email: string | null; phone: string | null; address: string | null; paymentTermDays: number | null; notes: string | null; status: "active" | "inactive"; }
export interface SalesOrderLine {
  id: number; productId: number; productName: string; sku: string; quantity: number; deliveredQuantity: number; remainingQuantity: number;
  unitPriceZmw: string; lineTotalZmw: string; stockLocationId: number | null; stockLocationName: string | null;
  stockReservations: { id: number; locationId: number | null; locationName: string | null; quantity: number; status: "active" | "released" | "fulfilled" }[];
  stockLocations: { id: number; name: string; available: number }[];
}
export interface SalesDeliveryReceiptProof { id: number | null; fileName: string; mimeType: string; }
export interface SalesDeliveryReceipt {
  receivedBy: string; receivedAt: string; proofFileName: string | null; proofMimeType: string | null;
  proofs: SalesDeliveryReceiptProof[];
}
export interface SalesDeliveryInvoiceEmailAttempt {
  id: number; attemptNumber: number; attemptedAt: string; recipientEmail: string;
  status: "sending" | "sent" | "failed" | "ambiguous"; sentAt: string | null;
  providerMessageId: string | null; error: string | null;
}
export interface SalesDelivery {
  id: number; deliveryNumber: string; deliveryDate: string; totalZmw: string; receipt: SalesDeliveryReceipt | null;
  invoiceEmailAttempts?: SalesDeliveryInvoiceEmailAttempt[];
  lines: {
    salesDeliveryLineId: number; salesOrderLineId: number; productName: string; sku: string;
    quantity: number; returnedQuantity: number;
    returns: { quantity: number; reason: string; createdAt: string; locationName: string | null }[];
    stockLocations: { locationId: number | null; locationName: string | null; quantity: number }[];
    unitPriceZmw: string; lineTotalZmw: string;
  }[];
}
export interface SalesOrder { id: number; orderNumber: string; customerId: number; customerName: string; status: "draft" | "confirmed" | "partially_fulfilled" | "fulfilled" | "cancelled"; orderDate: string; confirmedAt?: string | null; fulfilledAt: string | null; deliveryAddress: string | null; notes: string | null; totalZmw: string; deliveredZmw: string; deliveries: SalesDelivery[]; campaignId: number | null; campaignName: string | null; lines: SalesOrderLine[]; }
export type CustomerQuoteStatus = "draft" | "sent" | "accepted" | "rejected" | "converted";
export interface CustomerQuoteLine { id: number; productId: number; productName: string; sku: string; quantity: number; unitPriceZmw: string; lineTotalZmw: string; }
export type CustomerQuoteEmailStatus = "not_sent" | "sending" | "sent" | "delivered" | "bounced" | "failed" | "ambiguous";
export interface CustomerQuoteEmailAttempt {
  id: number; attemptNumber: number; attemptedAt: string; recipientEmail: string;
  status: "sending" | "sent" | "delivered" | "bounced" | "failed" | "ambiguous";
  sentAt: string | null; providerMessageId: string | null; error: string | null;
}
export interface CustomerQuoteEmailDeliveryEvent {
  id: number; provider: string; providerEventId: string; providerMessageId: string;
  outcome: "delivered" | "bounced" | "failed"; occurredAt: string; receivedAt: string;
}
export interface UnmatchedCustomerQuoteEmailEvent {
  id: number; provider: string; providerEventId: string; providerMessageId: string;
  outcome: "delivered" | "bounced" | "failed"; occurredAt: string; receivedAt: string;
  error: string | null; reviewedAt: string | null; reviewedBy: string | null;
}
export interface CustomerQuote {
  id: number; quoteNumber: string; customerId: number; customerName: string; customerEmail: string | null;
  status: CustomerQuoteStatus; emailSendStatus: CustomerQuoteEmailStatus; emailAttemptedAt: string | null;
  emailSentAt: string | null; emailSendError: string | null; emailProviderMessageId?: string | null;
  emailDeliveryEventAt: string | null; emailAttempts?: CustomerQuoteEmailAttempt[];
  emailDeliveryEvents?: CustomerQuoteEmailDeliveryEvent[]; createdAt: string; validUntil: string | null;
  deliveryAddress: string | null; notes: string | null; salesOrderId: number | null;
  salesOrderNumber: string | null; totalZmw: string; lines: CustomerQuoteLine[];
}
export interface CustomerQuoteInput { customerId: number; validUntil: string | null; deliveryAddress: string | null; notes: string | null; status: "draft" | "sent" | "accepted" | "rejected"; lines: { productId: number; quantity: number; unitPriceZmw: string }[]; }
export interface MarketingCampaignOption { id: number; name: string; status: string; }
export type PaymentDirection = "customer_receipt" | "supplier_payment";
export type PaymentMethod = "cash" | "bank_transfer" | "mobile_money" | "other";
export interface PaymentReminderHistoryEntry {
  id: number; status: "sending" | "sent" | "failed"; attemptedAt: string; sentAt: string | null;
  recipientEmail: string; outstandingZmw: string; error: string | null;
}
export interface PaymentOption {
  orderId: number | null; importExpenseId?: number | null; orderNumber: string; partyName: string; totalZmw: string; paidZmw: string; outstandingZmw: string;
  dueDate: string; dueDateSource: "calculated" | "saved" | "recorded";
  overdueDays: number; agingBucket: "not_due" | "1_30_days" | "31_60_days" | "over_60_days";
  customerEmail?: string | null;
  reminderHistory?: PaymentReminderHistoryEntry[];
}
export interface BusinessPayment { id: number; paymentNumber: string; direction: PaymentDirection; importExpenseId?: number | null; amountZmw: string; paymentDate: string; method: PaymentMethod; reference: string | null; notes: string | null; orderNumber: string; partyName: string; }
export interface PaymentOverview { payments: BusinessPayment[]; invoices: PaymentOption[]; bills: PaymentOption[]; }

export interface CurrentUser {
  authorized: boolean;
  email: string | null;
  role: "owner" | "manager" | null;
  reason?: "owner_not_configured" | "email_not_approved" | "email_not_verified";
}
export interface UserAccess {
  email: string;
  displayName: string | null;
  role: "owner" | "manager";
  active: boolean;
  createdAt: string;
}

export interface Category {
  id: number;
  name: string;
  description: string | null;
  status: CategoryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Supplier {
  id: number;
  name: string;
  country: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  paymentTerms: string | null;
  paymentTermDays: number | null;
  defaultLeadTimeDays: number;
  notes: string | null;
  status: SupplierStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierInput extends Omit<Supplier, "id" | "createdAt" | "updatedAt"> {}

export interface SupplierQuote {
  id: number;
  supplierId: number;
  productId: number;
  quoteReference: string | null;
  supplierProductCode: string | null;
  unitPrice: string;
  currency: string;
  minimumOrderQuantity: number;
  leadTimeDays: number;
  validUntil: string | null;
  paymentTerms: string | null;
  shippingTerms: string | null;
  notes: string | null;
  status: SupplierQuoteStatus;
  quotedAt: string;
  createdAt: string;
  updatedAt: string;
  supplierName: string;
  supplierStatus: SupplierStatus;
  productName: string;
  productSku: string;
}

export interface SupplierQuoteInput {
  supplierId: number;
  productId: number;
  quoteReference: string | null;
  supplierProductCode: string | null;
  unitPrice: string;
  currency: string;
  minimumOrderQuantity: number;
  leadTimeDays: number;
  validUntil: string | null;
  paymentTerms: string | null;
  shippingTerms: string | null;
  notes: string | null;
  status: SupplierQuoteStatus;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  brand: string | null;
  categoryId: number | null;
  supplierName: string | null;
  supplierProductCode: string | null;
  purchaseCurrency: string;
  purchasePrice: string | null;
  estimatedLandedCostZmw: string | null;
  sellingPriceZmw: string | null;
  estimatedGrossProfitZmw: string | null;
  estimatedGrossMarginPercent: string | null;
  reorderThreshold: number;
  unit: string;
  status: ProductStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProductInput {
  sku: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  brand: string | null;
  categoryId: number | null;
  supplierName: string | null;
  supplierProductCode: string | null;
  purchaseCurrency: string;
  purchasePrice: string | null;
  estimatedLandedCostZmw: string | null;
  sellingPriceZmw: string | null;
  reorderThreshold: number;
  unit: string;
  status: ProductStatus;
}

export interface ProductListParams {
  q?: string;
  status?: "all" | ProductStatus;
  categoryId?: number;
  page?: number;
  pageSize?: number;
}

export interface ProductListResult {
  products: Product[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init?.body && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & T;
  if (!response.ok) {
    throw new ApiError(body.error ?? "The request could not be completed.", response.status);
  }
  return body;
}

export async function fetchCurrentUser(): Promise<CurrentUser> {
  return request<CurrentUser>("/api/me");
}

export async function fetchUserAccess(): Promise<UserAccess[]> {
  return (await request<{ users: UserAccess[] }>("/api/user-access")).users;
}

export async function grantUserAccess(input: { email: string; displayName: string | null }): Promise<void> {
  await request("/api/user-access", { method: "POST", body: JSON.stringify(input) });
}

export async function setUserAccessActive(email: string, active: boolean): Promise<void> {
  await request(`/api/user-access/${encodeURIComponent(email)}`, {
    method: "PATCH",
    body: JSON.stringify({ active }),
  });
}

export async function fetchCategories(): Promise<Category[]> {
  const result = await request<{ categories: Category[] }>("/api/categories");
  return result.categories;
}

export async function createCategory(input: {
  name: string;
  description: string | null;
}): Promise<Category> {
  const result = await request<{ category: Category }>("/api/categories", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.category;
}

export async function updateCategory(
  id: number,
  input: { name: string; description: string | null; status: CategoryStatus },
): Promise<Category> {
  const result = await request<{ category: Category }>(`/api/categories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return result.category;
}

export async function fetchSuppliers(params: { q?: string; status?: "all" | SupplierStatus } = {}): Promise<Supplier[]> {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.status) query.set("status", params.status);
  const result = await request<{ suppliers: Supplier[] }>(`/api/suppliers?${query.toString()}`);
  return result.suppliers;
}

export async function createSupplier(input: SupplierInput): Promise<Supplier> {
  const result = await request<{ supplier: Supplier }>("/api/suppliers", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.supplier;
}

export async function updateSupplier(id: number, input: SupplierInput): Promise<Supplier> {
  const result = await request<{ supplier: Supplier }>(`/api/suppliers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return result.supplier;
}

export async function fetchSupplierQuotes(productId?: number): Promise<SupplierQuote[]> {
  const query = new URLSearchParams();
  if (productId) query.set("productId", String(productId));
  type QuoteRow = {
    quote: Omit<SupplierQuote, "supplierName" | "supplierStatus" | "productName" | "productSku">;
    supplierName: string;
    supplierStatus: SupplierStatus;
    productName: string;
    productSku: string;
  };
  const result = await request<{ quotes: QuoteRow[] }>(
    `/api/supplier-quotes?${query.toString()}`,
  );
  return result.quotes.map((row) => ({ ...row.quote, supplierName: row.supplierName, supplierStatus: row.supplierStatus, productName: row.productName, productSku: row.productSku }));
}

export async function createSupplierQuote(input: SupplierQuoteInput): Promise<void> {
  await request<{ quote: unknown }>("/api/supplier-quotes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchPurchaseOrders(): Promise<PurchaseOrder[]> {
  return (await request<{ orders: PurchaseOrder[] }>("/api/purchase-orders")).orders;
}
export async function createPurchaseOrder(input: {
  supplierId: number; currency: string; exchangeRateToZmw: string; expectedAt: string | null; notes: string | null;
  lines: { productId: number; quantityOrdered: number; unitPrice: string }[];
}): Promise<void> {
  await request("/api/purchase-orders", { method: "POST", body: JSON.stringify(input) });
}
export async function fetchShipments(): Promise<Shipment[]> {
  return (await request<{ shipments: Shipment[] }>("/api/shipments")).shipments;
}
export async function createShipment(input: {
  purchaseOrderIds: number[]; shipmentReference: string | null; carrier: string | null; trackingNumber: string | null;
  shippedAt: string | null; expectedAt: string | null; notes: string | null;
  lines: { purchaseOrderLineId: number; quantityShipped: number }[];
}): Promise<void> {
  await request("/api/shipments", { method: "POST", body: JSON.stringify(input) });
}
export async function receiveShipment(id: number, lines: { shipmentLineId: number; quantityReceived: number }[]): Promise<void> {
  await request(`/api/shipments/${id}/receive`, { method: "PATCH", body: JSON.stringify({ lines }) });
}
export async function fetchImportExpenses(): Promise<ImportExpense[]> {
  return (await request<{ expenses: ImportExpense[] }>("/api/import-expenses")).expenses;
}
export async function createImportExpense(input: {
  purchaseOrderId: number | null; shipmentId: number | null; category: string; description: string; amount: string; currency: string;
  exchangeRateToZmw: string; basis: AllocationBasis; incurredAt: string | null; reference: string | null; notes: string | null;
}): Promise<void> {
  await request("/api/import-expenses", { method: "POST", body: JSON.stringify(input) });
}
export async function fetchLandedCosts(): Promise<LandedCostOrder[]> {
  return (await request<{ orders: LandedCostOrder[] }>("/api/landed-costs")).orders;
}
export async function fetchAccountingJournalEntry(id: number): Promise<AccountingJournalEntry> {
  return (await request<{ entry: AccountingJournalEntry }>(`/api/accounting/journal-entries/${id}`)).entry;
}
export async function postLandedCostAdjustment(
  purchaseOrderId: number,
  preview: NonNullable<LandedCostOrder["adjustmentPreview"]>,
  note: string,
): Promise<void> {
  await request(`/api/landed-costs/${purchaseOrderId}/adjust`, {
    method: "POST",
    body: JSON.stringify({
      reviewedAmountZmw: preview.adjustmentAvailableZmw,
      reviewedLines: preview.lines.map(({ lineId, adjustmentZmw, inventoryZmw, cogsZmw }) => ({
        lineId, adjustmentZmw, inventoryZmw, cogsZmw,
      })),
      note,
    }),
  });
}
export async function fetchInventory(): Promise<{ inventory: InventoryItem[]; locationTotals: InventoryLocationTotal[] }> {
  return request<{ inventory: InventoryItem[]; locationTotals: InventoryLocationTotal[] }>("/api/inventory");
}
export async function fetchInventoryMovements(): Promise<InventoryMovement[]> {
  return (await request<{ movements: InventoryMovement[] }>("/api/inventory/movements")).movements;
}
export function inventoryMovementCorrectionLinks(movements: InventoryMovement[]): Map<number, string> {
  const correctedBy = new Map(movements
    .filter((movement) => movement.correctionOfMovementId !== null)
    .map((movement) => [movement.correctionOfMovementId!, movement]));
  return new Map(movements.map((movement) => {
    const child = correctedBy.get(movement.id);
    const link = movement.kind === "opening_stock_reversal"
      ? `Reverses #${movement.correctionOfMovementId}`
      : movement.correctionOfMovementId !== null
        ? `Replaces reversal #${movement.correctionOfMovementId}`
        : child ? `Corrected by #${child.id}` : "—";
    return [movement.id, link];
  }));
}
function spreadsheetSafeText(text: string): string {
  return /^[\s\u0000-\u001f]*[=+\-@]/.test(text) ? `'${text}` : text;
}
function safeCsvCell(value: unknown): string {
  const text = typeof value === "string" ? spreadsheetSafeText(value) : String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}
export function inventoryMovementHistoryCsv(movements: InventoryMovement[]): string {
  const correctionLinks = inventoryMovementCorrectionLinks(movements);
  const rows: unknown[][] = [
    ["Movement ID", "Date (UTC)", "Product", "SKU", "Location", "Type", "Quantity change", "Reason", "Correction link", "Reference", "Evidence filenames"],
    ...movements.map((movement) => [
      movement.id,
      movement.createdAt,
      movement.productName,
      movement.sku,
      movement.locationName || "Main",
      movement.kind.replaceAll("_", " "),
      movement.quantityDelta,
      movement.reason,
      correctionLinks.get(movement.id) ?? "—",
      movement.reference || "",
      movement.evidenceFiles.map((file) => spreadsheetSafeText(file.fileName)).join("; "),
    ]),
  ];
  return rows.map((row) => row.map(safeCsvCell).join(",")).join("\r\n");
}
function inventoryValueCents(value: string): bigint {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("Inventory values must be valid ZMW amounts.");
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -amount : amount;
}
function formatInventoryValueCents(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
export function inventoryLocationValuesCsv(locationTotals: InventoryLocationTotal[]): string {
  const totalCents = locationTotals.reduce((total, location) => total + inventoryValueCents(location.stockValueZmw), 0n);
  const rows = [
    ["Location", "Stock value (ZMW)"],
    ...locationTotals.map((location) => [location.name, formatInventoryValueCents(inventoryValueCents(location.stockValueZmw))]),
    ["Overall total", formatInventoryValueCents(totalCents)],
  ];
  return rows.map(([name, value], index) =>
    `${safeCsvCell(name)},${index === 0 ? safeCsvCell(value) : `"${value}"`}`
  ).join("\r\n");
}
export function inventoryProductLocationCsv(inventory: InventoryItem[]): string {
  const rows: unknown[][] = [
    ["Product", "SKU", "Location", "On hand", "Reserved", "Available", "Stock value (ZMW)"],
    ...inventory.flatMap((product) => product.locations.map((location) => [
      product.name,
      product.sku,
      location.name,
      location.onHand,
      location.reserved,
      location.available,
      formatInventoryValueCents(inventoryValueCents(location.stockValueZmw)),
    ])),
  ];
  return rows.map((row) => row.map(safeCsvCell).join(",")).join("\r\n");
}
export function salesDeliveryLocationCsv(orders: SalesOrder[]): string {
  const rows: unknown[][] = [
    ["Delivery date", "Delivery", "Order", "Customer", "Product", "SKU", "Stock location", "Delivered quantity"],
    ...orders.flatMap((order) => order.deliveries.flatMap((delivery) =>
      delivery.lines.flatMap((line) => line.stockLocations.map((location) => [
        delivery.deliveryDate,
        delivery.deliveryNumber,
        order.orderNumber,
        order.customerName,
        line.productName,
        line.sku,
        location.locationName || "Unassigned",
        location.quantity,
      ]))
    )),
  ];
  return rows.map((row) => row.map(safeCsvCell).join(",")).join("\r\n");
}
export function inventoryMovementEvidenceUrl(movementId: number, evidenceId?: number | null, download = false): string {
  const base = `/api/inventory/movements/${movementId}/opening-evidence${evidenceId == null ? "" : `/${evidenceId}`}`;
  return download ? `${base}?download=1` : base;
}
export function inventoryMovementEvidenceArchiveUrl(movementId: number): string {
  return `/api/inventory/movements/${movementId}/opening-evidence/archive`;
}
export async function fetchInventoryEvidenceArchive(movementIds: number[]): Promise<Blob> {
  const response = await fetch("/api/inventory/opening-evidence/archive", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ movementIds }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(body.error ?? "The count evidence archive could not be downloaded.", response.status);
  }
  return response.blob();
}
export async function fetchInventoryLocations(): Promise<InventoryLocation[]> {
  return (await request<{ locations: InventoryLocation[] }>("/api/inventory/locations")).locations;
}
export async function createInventoryLocation(name: string): Promise<void> {
  await request("/api/inventory/locations", { method: "POST", body: JSON.stringify({ name }) });
}
export async function transferInventory(input: {
  productId: number; fromLocationId: number; toLocationId: number; quantity: number;
  reason: string; reference: string | null; idempotencyKey: string;
}): Promise<void> {
  await request("/api/inventory/transfers", { method: "POST", body: JSON.stringify(input) });
}
export async function recordInventoryEvent(input: { kind: "stock_return" | "stock_damage"; productId: number; locationId: number; quantity: number; reason: string; reference: string | null }): Promise<void> {
  await request("/api/inventory/events", { method: "POST", body: JSON.stringify(input) });
}
export async function fetchInventoryReceipts(): Promise<InventoryReceipt[]> {
  return (await request<{ receipts: InventoryReceipt[] }>("/api/inventory/receipts")).receipts;
}
export async function postInventoryReceipt(shipmentLineId: number, locationId: number): Promise<void> {
  await request(`/api/inventory/receipts/${shipmentLineId}/post`, { method: "POST", body: JSON.stringify({ locationId }) });
}
export async function fetchUnlinkedReceiptJournals(): Promise<UnlinkedReceiptJournal[]> {
  return (await request<{ journals: UnlinkedReceiptJournal[] }>("/api/inventory/unlinked-receipt-journals")).journals;
}
export async function linkReceiptJournal(journalId: number, shipmentLineId: number): Promise<void> {
  await request(`/api/inventory/receipt-journals/${journalId}/link`, {
    method: "POST", body: JSON.stringify({ shipmentLineId }),
  });
}
export async function fetchReservations(): Promise<InventoryReservation[]> {
  return (await request<{ reservations: InventoryReservation[] }>("/api/inventory/reservations")).reservations;
}
export async function createReservation(input: { productId: number; locationId: number; quantity: number; reference: string | null; reason: string }): Promise<void> {
  await request("/api/inventory/reservations", { method: "POST", body: JSON.stringify(input) });
}
export async function releaseReservation(id: number): Promise<void> {
  await request(`/api/inventory/reservations/${id}/release`, { method: "POST" });
}
export async function fulfillReservation(id: number): Promise<void> {
  await request(`/api/inventory/reservations/${id}/fulfill`, { method: "POST" });
}
export async function createInventoryAdjustment(input: { productId: number; locationId: number; quantityDelta: number; reference: string | null; reason: string }): Promise<void> {
  await request("/api/inventory/adjustments", { method: "POST", body: JSON.stringify(input) });
}
export const MAX_OPENING_STOCK_EVIDENCE_BYTES = 5 * 1024 * 1024;
export const MAX_OPENING_STOCK_EVIDENCE_FILES = 5;
export function openingStockEvidenceErrors(evidence: readonly File[]): string[] {
  const errors: string[] = [];
  if (evidence.length > MAX_OPENING_STOCK_EVIDENCE_FILES) {
    errors.push(`Choose no more than ${MAX_OPENING_STOCK_EVIDENCE_FILES} count files.`);
  }
  evidence.forEach((file) => {
    if (file.size > MAX_OPENING_STOCK_EVIDENCE_BYTES) {
      errors.push(`${file.name} is larger than 5 MB.`);
    }
  });
  return errors;
}
export async function createOpeningStock(input: {
  productId: number; locationId: number; quantity: number; unitCostZmw: string; effectiveAt: string; memo: string; reference: string | null;
  evidence: File[];
}): Promise<void> {
  const { evidence, ...details } = input;
  const evidenceErrors = openingStockEvidenceErrors(evidence);
  if (evidenceErrors.length) throw new Error(evidenceErrors.join(" "));
  if (!evidence.length) {
    await request("/api/inventory/opening-stock", { method: "POST", body: JSON.stringify(details) });
    return;
  }
  const form = new FormData();
  Object.entries(details).forEach(([key, value]) => form.append(key, String(value ?? "")));
  evidence.forEach((file) => form.append("evidence", file, file.name));
  await request("/api/inventory/opening-stock", { method: "POST", body: form });
}
export async function appendOpeningStockEvidence(id: number, evidence: File[]): Promise<void> {
  const form = new FormData();
  evidence.forEach((file) => form.append("evidence", file, file.name));
  await request(`/api/inventory/opening-stock/${id}/evidence`, { method: "POST", body: form });
}
export async function correctOpeningStock(id: number, input: {
  quantity: number; unitCostZmw: string; effectiveAt: string; reason: string; reference: string | null;
}): Promise<void> {
  await request(`/api/inventory/opening-stock/${id}/correct`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
export async function fetchCustomers(): Promise<Customer[]> {
  return (await request<{ customers: Customer[] }>("/api/customers")).customers;
}
export async function saveCustomer(input: Omit<Customer, "id">, id?: number): Promise<void> {
  await request(id ? `/api/customers/${id}` : "/api/customers", { method: id ? "PATCH" : "POST", body: JSON.stringify(input) });
}
export async function fetchSalesOrders(): Promise<SalesOrder[]> {
  return (await request<{ orders: SalesOrder[] }>("/api/sales-orders")).orders;
}
export type PublicShopAttemptSummary = {
  accepted: number;
  blocked: number;
  rateLimited: number;
  botCheck: number;
  unclassifiedBlocked: number;
};
export async function fetchPublicShopOrderAttemptSummary(): Promise<PublicShopAttemptSummary> {
  return (await request<{ summary: PublicShopAttemptSummary }>("/api/shop/order-attempt-summary")).summary;
}
export type PublicShopAttemptDay = PublicShopAttemptSummary & { day: string };
export type PublicShopBlockedSpike = Pick<PublicShopAttemptDay, "day" | "blocked">;
export async function fetchPublicShopOrderAttemptDays(from: string, to: string): Promise<{
  days: PublicShopAttemptDay[];
  blockedSpikes: PublicShopBlockedSpike[];
}> {
  const params = new URLSearchParams({ from, to });
  return request<{ days: PublicShopAttemptDay[]; blockedSpikes: PublicShopBlockedSpike[] }>(`/api/shop/order-attempt-days?${params}`);
}
export async function fetchPublicShopOrderAttemptCsv(from: string, to: string): Promise<string> {
  const params = new URLSearchParams({ from, to });
  const response = await fetch(`/api/shop/order-attempt-export?${params}`, { credentials: "same-origin" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(body.error ?? "The request could not be completed.", response.status);
  }
  return response.text();
}
export function publicShopAttemptDaysCsv(days: PublicShopAttemptDay[]): string {
  const rows: unknown[][] = [
    ["Date (UTC)", "Accepted", "Blocked", "Rate-limited", "Challenge or honeypot failed"],
    ...days.map(({ day, accepted, blocked, rateLimited, botCheck }) => [day, accepted, blocked, rateLimited, botCheck]),
  ];
  return rows.map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
}
export async function fetchCustomerQuotes(): Promise<CustomerQuote[]> {
  return (await request<{ quotes: CustomerQuote[] }>("/api/customer-quotes")).quotes;
}
export async function fetchUnmatchedCustomerQuoteEmailEvents(): Promise<UnmatchedCustomerQuoteEmailEvent[]> {
  return (await request<{ events: UnmatchedCustomerQuoteEmailEvent[] }>("/api/customer-quote-email-notices")).events;
}
export async function markCustomerQuoteEmailEventReviewed(id: number): Promise<void> {
  await request(`/api/customer-quote-email-notices/${id}/reviewed`, { method: "PATCH" });
}
export async function saveCustomerQuote(input: CustomerQuoteInput, id?: number): Promise<void> {
  await request(id ? `/api/customer-quotes/${id}` : "/api/customer-quotes", { method: id ? "PATCH" : "POST", body: JSON.stringify(input) });
}
export async function deleteCustomerQuote(id: number): Promise<void> {
  await request(`/api/customer-quotes/${id}`, { method: "DELETE" });
}
export async function emailCustomerQuote(id: number, confirmAmbiguousRetry = false): Promise<void> {
  await request(`/api/customer-quotes/${id}/send`, {
    method: "POST",
    body: JSON.stringify({ confirmAmbiguousRetry }),
  });
}
export async function convertCustomerQuote(id: number, confirmExpired = false): Promise<string> {
  const result = await request<{ order: { orderNumber: string } }>(`/api/customer-quotes/${id}/convert`, {
    method: "POST", body: JSON.stringify({ confirmExpired }),
  });
  return result.order.orderNumber;
}
export async function fetchMarketingCampaigns(): Promise<MarketingCampaignOption[]> {
  return (await request<{ campaigns: MarketingCampaignOption[] }>("/api/marketing/campaigns")).campaigns;
}
export async function setSalesOrderAttribution(id: number, campaignId: number | null): Promise<void> {
  await request(`/api/sales-orders/${id}/attribution`, { method: "PATCH", body: JSON.stringify({ campaignId }) });
}
export async function createSalesOrder(input: { customerId: number; deliveryAddress: string | null; notes: string | null; lines: { productId: number; quantity: number; unitPriceZmw: string }[] }): Promise<void> {
  await request("/api/sales-orders", { method: "POST", body: JSON.stringify(input) });
}
export async function deleteSalesOrder(id: number): Promise<void> {
  await request(`/api/sales-orders/${id}`, { method: "DELETE" });
}
export async function updateSalesOrderStatus(
  id: number,
  action: "confirm" | "fulfill" | "cancel",
  locations?: { productId: number; locationId: number | null }[],
): Promise<void> {
  await request(`/api/sales-orders/${id}/${action}`, {
    method: "POST",
    ...(action === "confirm" ? { body: JSON.stringify({ locations: locations ?? [] }) } : {}),
  });
}
export async function createSalesDelivery(id: number, input: {
  idempotencyKey: string; deliveryDate: string;
  lines: { salesOrderLineId: number; quantity: number; locationAllocations?: { locationId: number; quantity: number }[] }[];
}): Promise<void> {
  await request(`/api/sales-orders/${id}/deliveries`, { method: "POST", body: JSON.stringify(input) });
}
export async function sendSalesDeliveryInvoice(deliveryId: number, options: {
  confirmAmbiguousRetry?: boolean; confirmResend?: boolean;
} = {}): Promise<string> {
  const result = await request<{ message: string }>(`/api/sales-deliveries/${deliveryId}/send-invoice`, {
    method: "POST", body: JSON.stringify(options),
  });
  return result.message;
}
export async function recordSalesReturn(
  deliveryLineId: number,
  input: { idempotencyKey: string; locationId: number; quantity: number; returnDate: string; reason: string },
): Promise<void> {
  await request(`/api/sales-delivery-lines/${deliveryLineId}/returns`, {
    method: "POST", body: JSON.stringify(input),
  });
}
export async function saveSalesDeliveryReceipt(
  deliveryId: number,
  input: { receivedBy: string; receivedAt: string },
): Promise<SalesDeliveryReceipt> {
  const query = new URLSearchParams({
    receivedBy: input.receivedBy,
    receivedAt: input.receivedAt,
  });
  const response = await fetch(`/api/sales-deliveries/${deliveryId}/receipt-proof?${query}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Blob([]),
  });
  const body = await response.json().catch(() => ({})) as { error?: string; receipt?: SalesDeliveryReceipt };
  if (!response.ok || !body.receipt) throw new ApiError(body.error ?? "The receipt details could not be saved.", response.status);
  return body.receipt;
}
export function salesDeliveryReceiptProofUrl(deliveryId: number): string {
  return `/api/sales-deliveries/${deliveryId}/receipt-proof`;
}
export async function addSalesDeliveryReceiptProof(deliveryId: number, file: File, idempotencyKey: string): Promise<SalesDeliveryReceiptProof> {
  const query = new URLSearchParams({ fileName: file.name });
  const response = await fetch(`/api/sales-deliveries/${deliveryId}/receipt-proofs?${query}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/octet-stream", "Idempotency-Key": idempotencyKey },
    body: file,
  });
  const body = await response.json().catch(() => ({})) as { error?: string; proof?: SalesDeliveryReceiptProof };
  if (!response.ok || !body.proof) throw new ApiError(body.error ?? "The signed proof could not be added.", response.status);
  return body.proof;
}
export function salesDeliveryReceiptProofFileUrl(deliveryId: number, proofId: number): string {
  return `/api/sales-deliveries/${deliveryId}/receipt-proofs/${proofId}`;
}

export async function updateSupplierQuote(id: number, input: SupplierQuoteInput): Promise<void> {
  await request<{ quote: unknown }>(`/api/supplier-quotes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function fetchProducts(
  params: ProductListParams = {},
): Promise<ProductListResult> {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.status) query.set("status", params.status);
  if (params.categoryId) query.set("categoryId", String(params.categoryId));
  if (params.page) query.set("page", String(params.page));
  if (params.pageSize) query.set("pageSize", String(params.pageSize));
  const result = await request<ProductListResult>(`/api/products?${query.toString()}`);
  return result;
}

export async function createProduct(input: ProductInput): Promise<Product> {
  const result = await request<{ product: Product }>("/api/products", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.product;
}

export async function updateProduct(id: number, input: ProductInput): Promise<Product> {
  const result = await request<{ product: Product }>(`/api/products/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
  return result.product;
}
