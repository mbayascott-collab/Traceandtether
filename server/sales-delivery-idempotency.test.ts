import assert from "node:assert/strict";
import test from "node:test";
import { matchesDeliveryRequest } from "./sales-delivery-idempotency";

const savedDelivery = {
  salesOrderId: 12,
  deliveryDate: "2026-11-18",
  lines: [
    { salesOrderLineId: 22, quantity: 2 },
    { salesOrderLineId: 21, quantity: 1 },
  ],
};

test("matches a retry of the same delivery even if line order differs", () => {
  assert.equal(matchesDeliveryRequest(savedDelivery, {
    salesOrderId: 12,
    deliveryDate: "2026-11-18",
    lines: [
      { salesOrderLineId: 21, quantity: 1 },
      { salesOrderLineId: 22, quantity: 2 },
    ],
  }), true);
});

test("rejects reuse of a delivery request key for different details", () => {
  assert.equal(matchesDeliveryRequest(savedDelivery, {
    salesOrderId: 12,
    deliveryDate: "2026-11-18",
    lines: [{ salesOrderLineId: 21, quantity: 2 }, { salesOrderLineId: 22, quantity: 2 }],
  }), false);
  assert.equal(matchesDeliveryRequest(savedDelivery, {
    salesOrderId: 13,
    deliveryDate: "2026-11-18",
    lines: savedDelivery.lines,
  }), false);
});

test("rejects reuse of a delivery request key with a different custom location split", () => {
  assert.equal(matchesDeliveryRequest({
    ...savedDelivery,
    lines: [{ salesOrderLineId: 21, quantity: 2, locationAllocations: [{ locationId: 3, quantity: 2 }] }],
  }, {
    salesOrderId: 12,
    deliveryDate: "2026-11-18",
    lines: [{ salesOrderLineId: 21, quantity: 2, locationAllocations: [{ locationId: 4, quantity: 2 }] }],
  }), false);
});
