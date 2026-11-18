import assert from "node:assert/strict";
import test from "node:test";
import { paymentAging } from "./payment-aging";

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
