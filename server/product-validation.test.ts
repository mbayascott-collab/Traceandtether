import assert from "node:assert/strict";
import test from "node:test";
import {
  customerInputSchema, customerQuoteInputSchema, importExpenseInputSchema, inventoryAdjustmentInputSchema, inventoryReservationInputSchema, openingStockInputSchema, productInputSchema, purchaseOrderInputSchema, salesDeliveryInputSchema, salesOrderInputSchema, shipmentInputSchema,
  publicShopOrderInputSchema, shipmentReceiptSchema, supplierInputSchema, supplierQuoteInputSchema,
} from "./product-validation";

const validProduct = {
  sku: "mz-001",
  name: "Portable lamp",
  description: "",
  brand: "",
  categoryId: "",
  supplierName: "Example supplier",
  supplierProductCode: "LAMP-02",
  purchaseCurrency: "cny",
  purchasePrice: "12.50",
  estimatedLandedCostZmw: "225",
  sellingPriceZmw: "360.00",
  reorderThreshold: "5",
  unit: "unit",
  status: "draft",
};

test("normalizes product identifiers, text and currency", () => {
  const result = productInputSchema.parse(validProduct);
  assert.equal(result.sku, "MZ-001");
  assert.equal(result.purchaseCurrency, "CNY");
  assert.equal(result.categoryId, null);
  assert.equal(result.description, null);
  assert.equal(result.reorderThreshold, 5);
});

test("rejects negative monetary values", () => {
  const result = productInputSchema.safeParse({
    ...validProduct,
    purchasePrice: "-0.01",
  });
  assert.equal(result.success, false);
});

test("requires an active product to have a positive ZMW selling price", () => {
  const result = productInputSchema.safeParse({
    ...validProduct,
    status: "active",
    sellingPriceZmw: "0.00",
  });
  assert.equal(result.success, false);
});

test("rejects unsupported currency code shapes and negative reorder points", () => {
  assert.equal(
    productInputSchema.safeParse({ ...validProduct, purchaseCurrency: "USDX" }).success,
    false,
  );
  assert.equal(
    productInputSchema.safeParse({ ...validProduct, reorderThreshold: -1 }).success,
    false,
  );
});

test("validates supplier contacts, URLs, and non-negative lead times", () => {
  const supplier = {
    name: "  Pearl River Supply  ",
    country: "China",
    contactName: null,
    email: "buyer@example.com",
    phone: null,
    website: "https://supplier.example",
    paymentTerms: null,
    defaultLeadTimeDays: "18",
    notes: null,
    status: "active",
  };
  assert.equal(supplierInputSchema.parse(supplier).name, "Pearl River Supply");
  assert.equal(supplierInputSchema.safeParse({ ...supplier, email: "not-an-email" }).success, false);
  assert.equal(supplierInputSchema.safeParse({ ...supplier, website: "not-a-url" }).success, false);
  assert.equal(supplierInputSchema.safeParse({ ...supplier, defaultLeadTimeDays: "-1" }).success, false);
});

test("validates customer quote lines, prices, and duplicate products", () => {
  const quote = {
    customerId: "1", validUntil: "2026-12-31", deliveryAddress: null, notes: null, status: "draft",
    lines: [{ productId: "2", quantity: "3", unitPriceZmw: "125.50" }],
  };
  assert.equal(customerQuoteInputSchema.parse(quote).lines[0]?.quantity, 3);
  assert.equal(customerQuoteInputSchema.safeParse({ ...quote, lines: [{ ...quote.lines[0], unitPriceZmw: "-1" }] }).success, false);
  assert.equal(customerQuoteInputSchema.safeParse({ ...quote, lines: [...quote.lines, ...quote.lines] }).success, false);
  assert.equal(customerQuoteInputSchema.safeParse({ ...quote, validUntil: "2026-02-30" }).success, false);
});

test("validates quotation currency, amounts, quantities, and calendar dates", () => {
  const quote = {
    supplierId: "1",
    productId: "2",
    quoteReference: null,
    supplierProductCode: null,
    unitPrice: "12.50",
    currency: "cny",
    minimumOrderQuantity: "1",
    leadTimeDays: "20",
    validUntil: "2026-12-31",
    paymentTerms: null,
    shippingTerms: null,
    notes: null,
    status: "received",
  };
  assert.equal(supplierQuoteInputSchema.parse(quote).currency, "CNY");
  assert.equal(supplierQuoteInputSchema.safeParse({ ...quote, unitPrice: "-0.01" }).success, false);
  assert.equal(supplierQuoteInputSchema.safeParse({ ...quote, unitPrice: "2.999" }).success, false);
  assert.equal(supplierQuoteInputSchema.safeParse({ ...quote, minimumOrderQuantity: "0" }).success, false);
  assert.equal(supplierQuoteInputSchema.safeParse({ ...quote, validUntil: "2026-02-30" }).success, false);
});

test("validates purchase order rates, lines, and duplicate products", () => {
  const order = {
    supplierId: 1, currency: "cny", exchangeRateToZmw: "3.25000000", expectedAt: null, notes: null,
    lines: [{ productId: 2, quantityOrdered: 4, unitPrice: "12.50" }],
  };
  assert.equal(purchaseOrderInputSchema.parse(order).currency, "CNY");
  assert.equal(purchaseOrderInputSchema.safeParse({ ...order, exchangeRateToZmw: "0" }).success, false);
  assert.equal(purchaseOrderInputSchema.safeParse({ ...order, lines: [...order.lines, ...order.lines] }).success, false);
  assert.equal(purchaseOrderInputSchema.safeParse({ ...order, lines: [{ ...order.lines[0], unitPrice: "-1" }] }).success, false);
});

test("validates shipment and expense inputs", () => {
  const shipment = {
    purchaseOrderId: 1, shipmentReference: null, carrier: null, trackingNumber: null, shippedAt: null,
    expectedAt: "2026-12-01", notes: null, lines: [{ purchaseOrderLineId: 3, quantityShipped: 4 }],
  };
  assert.equal(shipmentInputSchema.safeParse(shipment).success, true);
  assert.equal(shipmentReceiptSchema.safeParse({ lines: [{ shipmentLineId: 1, quantityReceived: -1 }] }).success, false);
  const expense = {
    purchaseOrderId: 1, category: "Freight", description: "Sea freight", amount: "120.00", currency: "USD",
    exchangeRateToZmw: "26.50000000", basis: "value", incurredAt: "2026-11-03", reference: null, notes: null,
  };
  assert.equal(importExpenseInputSchema.safeParse(expense).success, true);
  assert.equal(importExpenseInputSchema.safeParse({ ...expense, amount: "0.00" }).success, false);
});

test("validates reservation quantities and non-zero reasoned stock adjustments", () => {
  assert.equal(inventoryReservationInputSchema.safeParse({ productId: 1, quantity: 2, reference: null, reason: "Customer order" }).success, true);
  assert.equal(inventoryReservationInputSchema.safeParse({ productId: 1, quantity: 0, reference: null, reason: "Hold" }).success, false);
  assert.equal(inventoryAdjustmentInputSchema.safeParse({ productId: 1, quantityDelta: -2, reference: null, reason: "Cycle count correction" }).success, true);
  assert.equal(inventoryAdjustmentInputSchema.safeParse({ productId: 1, quantityDelta: 0, reference: null, reason: "No change" }).success, false);
  assert.equal(inventoryAdjustmentInputSchema.safeParse({ productId: 1, quantityDelta: 2, reference: null, reason: " " }).success, false);
});

test("validates opening stock quantity and positive ZMW average cost", () => {
  const opening = { productId: 1, quantity: 4, unitCostZmw: "25.50", reference: "First count" };
  assert.equal(openingStockInputSchema.safeParse(opening).success, true);
  assert.equal(openingStockInputSchema.safeParse({ ...opening, quantity: 0 }).success, false);
  assert.equal(openingStockInputSchema.safeParse({ ...opening, unitCostZmw: "0" }).success, false);
  assert.equal(openingStockInputSchema.safeParse({ ...opening, unitCostZmw: "-1" }).success, false);
  assert.equal(openingStockInputSchema.safeParse({ ...opening, quantity: 1_000_000, unitCostZmw: "9999999999.99" }).success, false);
});

test("validates customer contacts and ZMW sales order lines", () => {
  const customer = { name: "Kabwe Retail", contactPerson: "  Sarah Banda  ", contactPersonPhone: "+260 977 000 000", email: "orders@example.com", phone: null, address: null, notes: null, status: "active" };
  assert.equal(customerInputSchema.safeParse(customer).success, true);
  assert.equal(customerInputSchema.parse(customer).contactPerson, "Sarah Banda");
  assert.equal(customerInputSchema.parse(customer).contactPersonPhone, "+260 977 000 000");
  assert.equal(customerInputSchema.safeParse({ ...customer, email: "bad-email" }).success, false);
  assert.equal(customerInputSchema.safeParse({ ...customer, contactPerson: "x".repeat(121) }).success, false);
  assert.equal(customerInputSchema.safeParse({ ...customer, contactPersonPhone: "x".repeat(61) }).success, false);
  const order = { customerId: 1, deliveryAddress: null, notes: null, lines: [{ productId: 2, quantity: 3, unitPriceZmw: "120.50" }] };
  assert.equal(salesOrderInputSchema.safeParse(order).success, true);
  assert.equal(salesOrderInputSchema.safeParse({ ...order, lines: [{ ...order.lines[0], unitPriceZmw: "-2" }] }).success, false);
  assert.equal(salesOrderInputSchema.safeParse({ ...order, lines: [...order.lines, ...order.lines] }).success, false);
});

test("validates delivery dates, positive quantities, and unique order lines", () => {
  assert.deepEqual(salesDeliveryInputSchema.parse({
    deliveryDate: "2026-11-04",
    lines: [{ salesOrderLineId: "4", quantity: "2" }],
  }), { deliveryDate: "2026-11-04", lines: [{ salesOrderLineId: 4, quantity: 2 }] });
  assert.equal(salesDeliveryInputSchema.safeParse({
    deliveryDate: "2026-02-30",
    lines: [{ salesOrderLineId: 4, quantity: 2 }],
  }).success, false);
  assert.equal(salesDeliveryInputSchema.safeParse({
    deliveryDate: "2026-11-04",
    lines: [{ salesOrderLineId: 4, quantity: 2 }, { salesOrderLineId: 4, quantity: 1 }],
  }).success, false);
});

test("validates public shop order requests without accepting client prices", () => {
  const request = {
    name: "A customer", phone: "+260 977 000 000", email: "",
    address: "", notes: "", lines: [{ productId: 2, quantity: 3 }],
  };
  assert.equal(publicShopOrderInputSchema.safeParse(request).success, true);
  assert.equal(publicShopOrderInputSchema.safeParse({ ...request, lines: [{ productId: 2, quantity: 0 }] }).success, false);
  assert.equal(publicShopOrderInputSchema.safeParse({ ...request, lines: [...request.lines, ...request.lines] }).success, false);
  assert.equal(publicShopOrderInputSchema.safeParse({ ...request, lines: [{ ...request.lines[0], unitPriceZmw: "0.01" }] }).success, false);
});
