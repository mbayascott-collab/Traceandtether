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
  id: number; purchaseOrderLineId: number; productName: string; sku: string; quantityShipped: number;
  quantityReceived: number; quantityOrdered: number;
}
export interface Shipment {
  id: number; purchaseOrderId: number; orderNumber: string; supplierName: string; shipmentReference: string | null;
  carrier: string | null; trackingNumber: string | null; status: ShipmentStatus; shippedAt: string | null;
  expectedAt: string | null; lines: ShipmentLine[];
}
export interface ImportExpense {
  id: number; purchaseOrderId: number; category: string; description: string; amount: string; currency: string;
  exchangeRateToZmw: string; basis: AllocationBasis; incurredAt: string; reference: string | null;
}
export interface LandedCostOrder extends PurchaseOrder {
  allocations: { expenseId: number; lineId: number; amountZmw: string }[];
  lines: (PurchaseOrderLine & { allocatedExpensesZmw: string; purchaseUnitCostZmw: string; landedUnitCostZmw: string })[];
}
export interface InventoryItem { id: number; name: string; sku: string; unit: string; status: ProductStatus; onHand: number; reserved: number; available: number; }
export interface InventoryMovement { id: number; productId: number; productName: string; sku: string; kind: string; quantityDelta: number; reason: string; reference: string | null; createdAt: string; }
export interface InventoryReservation { id: number; productId: number; productName: string; sku: string; quantity: number; status: "active" | "released" | "fulfilled"; reference: string | null; reason: string; salesOrderId: number | null; createdAt: string; }
export interface InventoryReceipt { id: number; quantityToPost: number; quantityReceived: number; quantityStocked: number; shipmentReference: string | null; orderNumber: string; supplierName: string; productName: string; sku: string; }
export interface Customer { id: number; name: string; email: string | null; phone: string | null; address: string | null; notes: string | null; status: "active" | "inactive"; }
export interface SalesOrderLine { id: number; productId: number; productName: string; sku: string; quantity: number; unitPriceZmw: string; lineTotalZmw: string; }
export interface SalesOrder { id: number; orderNumber: string; customerId: number; customerName: string; status: "draft" | "confirmed" | "fulfilled" | "cancelled"; orderDate: string; confirmedAt?: string | null; fulfilledAt: string | null; deliveryAddress: string | null; notes: string | null; totalZmw: string; campaignId: number | null; campaignName: string | null; lines: SalesOrderLine[]; }
export type CustomerQuoteStatus = "draft" | "sent" | "accepted" | "rejected" | "converted";
export interface CustomerQuoteLine { id: number; productId: number; productName: string; sku: string; quantity: number; unitPriceZmw: string; lineTotalZmw: string; }
export interface CustomerQuote { id: number; quoteNumber: string; customerId: number; customerName: string; status: CustomerQuoteStatus; createdAt: string; validUntil: string | null; deliveryAddress: string | null; notes: string | null; salesOrderId: number | null; salesOrderNumber: string | null; totalZmw: string; lines: CustomerQuoteLine[]; }
export interface CustomerQuoteInput { customerId: number; validUntil: string | null; deliveryAddress: string | null; notes: string | null; status: "draft" | "sent" | "accepted" | "rejected"; lines: { productId: number; quantity: number; unitPriceZmw: string }[]; }
export interface MarketingCampaignOption { id: number; name: string; status: string; }
export type PaymentDirection = "customer_receipt" | "supplier_payment";
export type PaymentMethod = "cash" | "bank_transfer" | "mobile_money" | "other";
export interface PaymentOption { orderId: number; orderNumber: string; partyName: string; totalZmw: string; paidZmw: string; outstandingZmw: string; }
export interface BusinessPayment { id: number; paymentNumber: string; direction: PaymentDirection; amountZmw: string; paymentDate: string; method: PaymentMethod; reference: string | null; notes: string | null; orderNumber: string; partyName: string; }
export interface PaymentOverview { payments: BusinessPayment[]; invoices: PaymentOption[]; bills: PaymentOption[]; }

export interface CurrentUser {
  authorized: boolean;
  email: string | null;
  role: "owner" | null;
  reason?: "owner_not_configured" | "email_not_approved" | "email_not_verified";
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
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
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
  purchaseOrderId: number; shipmentReference: string | null; carrier: string | null; trackingNumber: string | null;
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
  purchaseOrderId: number; category: string; description: string; amount: string; currency: string;
  exchangeRateToZmw: string; basis: AllocationBasis; incurredAt: string | null; reference: string | null; notes: string | null;
}): Promise<void> {
  await request("/api/import-expenses", { method: "POST", body: JSON.stringify(input) });
}
export async function fetchLandedCosts(): Promise<LandedCostOrder[]> {
  return (await request<{ orders: LandedCostOrder[] }>("/api/landed-costs")).orders;
}
export async function fetchInventory(): Promise<InventoryItem[]> {
  return (await request<{ inventory: InventoryItem[] }>("/api/inventory")).inventory;
}
export async function fetchInventoryMovements(): Promise<InventoryMovement[]> {
  return (await request<{ movements: InventoryMovement[] }>("/api/inventory/movements")).movements;
}
export async function fetchInventoryReceipts(): Promise<InventoryReceipt[]> {
  return (await request<{ receipts: InventoryReceipt[] }>("/api/inventory/receipts")).receipts;
}
export async function postInventoryReceipt(shipmentLineId: number): Promise<void> {
  await request(`/api/inventory/receipts/${shipmentLineId}/post`, { method: "POST" });
}
export async function fetchReservations(): Promise<InventoryReservation[]> {
  return (await request<{ reservations: InventoryReservation[] }>("/api/inventory/reservations")).reservations;
}
export async function createReservation(input: { productId: number; quantity: number; reference: string | null; reason: string }): Promise<void> {
  await request("/api/inventory/reservations", { method: "POST", body: JSON.stringify(input) });
}
export async function releaseReservation(id: number): Promise<void> {
  await request(`/api/inventory/reservations/${id}/release`, { method: "POST" });
}
export async function fulfillReservation(id: number): Promise<void> {
  await request(`/api/inventory/reservations/${id}/fulfill`, { method: "POST" });
}
export async function createInventoryAdjustment(input: { productId: number; quantityDelta: number; reference: string | null; reason: string }): Promise<void> {
  await request("/api/inventory/adjustments", { method: "POST", body: JSON.stringify(input) });
}
export async function createOpeningStock(input: { productId: number; quantity: number; unitCostZmw: string; reference: string | null }): Promise<void> {
  await request("/api/inventory/opening-stock", { method: "POST", body: JSON.stringify(input) });
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
export async function fetchCustomerQuotes(): Promise<CustomerQuote[]> {
  return (await request<{ quotes: CustomerQuote[] }>("/api/customer-quotes")).quotes;
}
export async function saveCustomerQuote(input: CustomerQuoteInput, id?: number): Promise<void> {
  await request(id ? `/api/customer-quotes/${id}` : "/api/customer-quotes", { method: id ? "PATCH" : "POST", body: JSON.stringify(input) });
}
export async function deleteCustomerQuote(id: number): Promise<void> {
  await request(`/api/customer-quotes/${id}`, { method: "DELETE" });
}
export async function convertCustomerQuote(id: number): Promise<string> {
  const result = await request<{ order: { orderNumber: string } }>(`/api/customer-quotes/${id}/convert`, { method: "POST" });
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
export async function updateSalesOrderStatus(id: number, action: "confirm" | "fulfill" | "cancel"): Promise<void> {
  await request(`/api/sales-orders/${id}/${action}`, { method: "POST" });
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
