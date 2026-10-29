import assert from "node:assert/strict";
import test from "node:test";
import { productInputSchema } from "./product-validation";

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
