import assert from "node:assert/strict";
import test from "node:test";
import { productInputSchema, supplierInputSchema, supplierQuoteInputSchema } from "./product-validation";

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
