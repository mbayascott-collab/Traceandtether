import assert from "node:assert/strict";
import test from "node:test";
import { filterCustomerPurchaseHistory, matchesCustomerPurchaseHistory, pageCustomerPurchaseHistory } from "./customer-purchase-history";

const order = {
  orderNumber: "SO-00421",
  orderDate: "2026-06-03",
  fulfilledAt: null,
  status: "partially_fulfilled" as const,
  deliveries: [
    { deliveryNumber: "DN-00421-02", deliveryDate: "2026-06-12" },
  ],
};

test("customer purchase search matches order and delivery note numbers without case sensitivity", () => {
  assert.equal(matchesCustomerPurchaseHistory(order, "so-00421"), true);
  assert.equal(matchesCustomerPurchaseHistory(order, "dn-00421-02"), true);
});

test("customer purchase search matches order and delivery dates", () => {
  assert.equal(matchesCustomerPurchaseHistory(order, "2026-06-03"), true);
  assert.equal(matchesCustomerPurchaseHistory(order, "2026-06-12"), true);
});

test("fulfilled orders without saved deliveries can be found by their generated delivery note number", () => {
  assert.equal(matchesCustomerPurchaseHistory({
    ...order,
    fulfilledAt: "2026-06-18T09:30:00.000Z",
    status: "fulfilled",
    deliveries: [],
  }, "DN-00421"), true);
  assert.equal(matchesCustomerPurchaseHistory({
    ...order,
    fulfilledAt: "2026-06-18T09:30:00.000Z",
    status: "fulfilled",
    deliveries: [],
  }, "2026-06-18"), true);
});

test("customer purchase search matches every order for an empty query and none for an unrelated query", () => {
  assert.equal(matchesCustomerPurchaseHistory(order, "  "), true);
  assert.equal(matchesCustomerPurchaseHistory(order, "DN-99999"), false);
});

test("filtering customer purchase history keeps the original delivery proof links", () => {
  const withProof = {
    ...order,
    receipt: undefined,
    deliveries: [{
      deliveryNumber: "DN-00421-02",
      deliveryDate: "2026-06-12",
      receipt: {
        receivedBy: "Customer",
        receivedAt: "2026-06-12T12:00:00.000Z",
        proofs: [{ id: 45, fileName: "signed.pdf", mimeType: "application/pdf" }],
      },
    }],
  };
  const filtered = filterCustomerPurchaseHistory([withProof], "DN-00421-02");
  assert.equal(filtered[0], withProof, "Filtering should retain the full purchase record.");
  assert.deepEqual(filtered[0]?.deliveries[0]?.receipt?.proofs, withProof.deliveries[0]?.receipt?.proofs);
});

test("purchase history pages results after searching the full customer history", () => {
  const orders = Array.from({ length: 40 }, (_, index) => ({
    ...order,
    orderNumber: `SO-${String(index + 1).padStart(5, "0")}`,
    deliveries: [{
      deliveryNumber: `DN-${String(index + 1).padStart(5, "0")}`,
      deliveryDate: "2026-06-12",
      receipt: {
        receivedBy: "Customer",
        receivedAt: "2026-06-12T12:00:00.000Z",
        proofs: [{ id: index + 1, fileName: `signed-${index + 1}.pdf`, mimeType: "application/pdf" }],
      },
    }],
  }));
  const firstPage = pageCustomerPurchaseHistory(orders, "", 25);
  assert.equal(firstPage.visible.length, 25);
  assert.equal(firstPage.matching.length, 40);
  assert.equal(firstPage.hasMore, true);

  const laterMatch = pageCustomerPurchaseHistory(orders, "DN-00040", 25);
  assert.equal(laterMatch.matching.length, 1, "Search must include entries beyond the first visible page.");
  assert.equal(laterMatch.visible[0]?.orderNumber, "SO-00040");
  assert.equal(laterMatch.visible[0]?.deliveries[0]?.receipt?.proofs[0]?.fileName, "signed-40.pdf");
  assert.equal(laterMatch.hasMore, false);
});
