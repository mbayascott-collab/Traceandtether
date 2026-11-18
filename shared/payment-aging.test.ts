import assert from "node:assert/strict";
import test from "node:test";
import { effectivePaymentDueDate, paymentAging, paymentDueDate } from "./payment-aging";

test("groups balances by days past due, including exact boundaries", () => {
  assert.deepEqual(paymentAging("2026-11-19", "2026-11-18"), { overdueDays: 0, agingBucket: "not_due" });
  assert.deepEqual(paymentAging("2026-11-18", "2026-11-18"), { overdueDays: 0, agingBucket: "not_due" });
  assert.deepEqual(paymentAging("2026-10-19", "2026-11-18"), { overdueDays: 30, agingBucket: "1_30_days" });
  assert.deepEqual(paymentAging("2026-10-18", "2026-11-18"), { overdueDays: 31, agingBucket: "31_60_days" });
  assert.deepEqual(paymentAging("2026-09-19", "2026-11-18"), { overdueDays: 60, agingBucket: "31_60_days" });
  assert.deepEqual(paymentAging("2026-09-18", "2026-11-18"), { overdueDays: 61, agingBucket: "over_60_days" });
});

test("rejects invalid aging dates", () => {
  assert.throws(() => paymentAging("not-a-date", "2026-11-18"), /valid calendar dates/);
});

test("payment due dates add configured days using calendar dates", () => {
  assert.equal(paymentDueDate("2026-11-18", 30), "2026-12-18");
  assert.equal(paymentDueDate("2024-02-28", 1), "2024-02-29");
  assert.equal(paymentDueDate("2026-11-18", 0), "2026-11-18");
  assert.equal(paymentDueDate("2026-11-18", null), "2026-11-18");
  assert.equal(effectivePaymentDueDate(null, "2026-11-18", 30), "2026-12-18");
  assert.equal(effectivePaymentDueDate("2026-12-01", "2026-11-18", 30), "2026-12-01");
});

test("rejects invalid payment due dates and day counts", () => {
  assert.throws(() => paymentDueDate("2026-02-30", 5), /valid calendar date/);
  assert.throws(() => paymentDueDate("2026-11-18", -1), /non-negative whole number/);
  assert.throws(() => paymentDueDate("2026-11-18", 1.5), /non-negative whole number/);
});
