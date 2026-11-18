import test from "node:test";
import assert from "node:assert/strict";
import { paymentInputSchema } from "./payment-validation";

const goodPayment = {
  direction: "customer_receipt",
  idempotencyKey: "51ed98ad-9bb4-4a4d-bacf-95cebbda44ce",
  orderId: "2",
  amountZmw: "125.50",
  paymentDate: "2026-11-04",
  method: "mobile_money",
  reference: "",
  notes: "",
};

test("validates positive ZMW payments and real dates", () => {
  assert.equal(paymentInputSchema.safeParse(goodPayment).success, true);
  assert.equal(paymentInputSchema.safeParse({ ...goodPayment, amountZmw: "0.00" }).success, false);
  assert.equal(paymentInputSchema.safeParse({ ...goodPayment, amountZmw: "-1" }).success, false);
  assert.equal(paymentInputSchema.safeParse({ ...goodPayment, amountZmw: "1.001" }).success, false);
  assert.equal(paymentInputSchema.safeParse({ ...goodPayment, paymentDate: "2026-02-30" }).success, false);
  assert.equal(paymentInputSchema.safeParse({ ...goodPayment, method: "cheque" }).success, false);
  assert.equal(paymentInputSchema.safeParse({ ...goodPayment, idempotencyKey: "not-a-key" }).success, false);
});

test("supplier payments target one purchase order or one shared shipment bill", () => {
  const supplierPayment = { ...goodPayment, direction: "supplier_payment" as const };
  assert.equal(paymentInputSchema.safeParse(supplierPayment).success, true);
  assert.equal(paymentInputSchema.safeParse({
    ...supplierPayment, orderId: null, importExpenseId: "17",
  }).success, true);
  assert.equal(paymentInputSchema.safeParse({
    ...supplierPayment, orderId: null, importExpenseId: null,
  }).success, false);
  assert.equal(paymentInputSchema.safeParse({
    ...supplierPayment, importExpenseId: "17",
  }).success, false);
  assert.equal(paymentInputSchema.safeParse({
    ...goodPayment, importExpenseId: "17",
  }).success, false);
});
