import assert from "node:assert/strict";
import test from "node:test";
import { filterInventoryMovements, inventoryMovementBusinessDate } from "./inventory-movement-filter";

const movements = [
  { id: 1, productId: 12, createdAt: "2026-11-17T20:30:00.000Z" },
  { id: 2, productId: 12, createdAt: "2026-11-18T08:00:00.000Z" },
  { id: 3, productId: 34, createdAt: "2026-11-18T11:00:00.000Z" },
];

test("stock-history filters match product and inclusive Zambia business dates", () => {
  assert.deepEqual(
    filterInventoryMovements(movements, { productId: 12, fromDate: "2026-11-17", toDate: "2026-11-18" })
      .map((movement) => movement.id),
    [1, 2],
  );
  assert.equal(inventoryMovementBusinessDate("2026-11-17T20:30:00.000Z"), "2026-11-17");
});

test("clearing stock-history filters restores all available movements", () => {
  assert.deepEqual(filterInventoryMovements(movements, {}), movements);
});
