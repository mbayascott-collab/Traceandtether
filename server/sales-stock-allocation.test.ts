import assert from "node:assert/strict";
import test from "node:test";
import { chooseSalesStockLocation } from "./sales-stock-allocation";

const locations = [
  { id: 1, name: "Main", available: 2 },
  { id: 2, name: "Lusaka Store", available: 7 },
  { id: 3, name: "Overflow", available: 5 },
];

test("automatic selection keeps using Main when it can cover the order", () => {
  assert.deepEqual(chooseSalesStockLocation(locations, 2, null), { location: locations[0] });
});

test("automatic selection uses another location when Main is short", () => {
  assert.deepEqual(chooseSalesStockLocation(locations, 4, null), { location: locations[1] });
});

test("a requested location is honored when it has enough available stock", () => {
  assert.deepEqual(chooseSalesStockLocation(locations, 4, 2), { location: locations[1] });
});

test("requested and automatic locations fail clearly when stock is insufficient", () => {
  assert.deepEqual(chooseSalesStockLocation(locations, 8, 2), {
    error: "7 units available at Lusaka Store; 8 requested.",
  });
  assert.deepEqual(chooseSalesStockLocation(locations, 8, null), {
    error: "No single stock location has enough available. Up to 7 units available; 8 requested.",
  });
});

test("a location that is no longer active cannot be selected", () => {
  assert.deepEqual(chooseSalesStockLocation(locations, 1, 99), {
    error: "The selected stock location is no longer active. Choose another location.",
  });
});
