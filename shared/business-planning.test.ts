import assert from "node:assert/strict";
import test from "node:test";
import { forecastCashWithin30Days, suggestedReorderQuantity } from "./business-planning";

test("suggests enough stock to reach the reorder level after reservations and incoming orders", () => {
  assert.equal(suggestedReorderQuantity(4, 1, 2, 10), 5);
  assert.equal(suggestedReorderQuantity(8, 1, 2, 10), 1);
  assert.equal(suggestedReorderQuantity(12, 0, 2, 10), 0);
});

test("forecasts current receivables and payables within 30 days", () => {
  assert.deepEqual(forecastCashWithin30Days(1_000n, 500n, -250n), {
    recordedCash: 1_000n, expectedReceipts: 500n, expectedPayments: 250n, estimatedClosing: 1_250n,
  });
});
