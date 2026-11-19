import assert from "node:assert/strict";
import test from "node:test";
import { allocateReservationConsumption, chooseSalesStockAllocations, chooseSalesStockLocation } from "./sales-stock-allocation";

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

test("automatic allocation splits a line across locations in stable priority order", () => {
  assert.deepEqual(chooseSalesStockAllocations(locations, 9, null), {
    allocations: [
      { ...locations[0], quantity: 2 },
      { ...locations[1], quantity: 7 },
    ],
  });
});

test("automatic allocation keeps a line in one location whenever possible", () => {
  assert.deepEqual(chooseSalesStockAllocations(locations, 4, null), {
    allocations: [{ ...locations[1], quantity: 4 }],
  });
});

test("a requested location is honored only when it can cover the whole sales line", () => {
  assert.deepEqual(chooseSalesStockAllocations(locations, 4, 2), {
    allocations: [{ ...locations[1], quantity: 4 }],
  });
  assert.deepEqual(chooseSalesStockAllocations(locations, 8, 2), {
    error: "7 units available at Lusaka Store; 8 requested.",
  });
  assert.deepEqual(chooseSalesStockAllocations(locations, 1, 99), {
    error: "The selected stock location is no longer active. Choose another location.",
  });
});

test("automatic allocation reports total available stock when all locations are short", () => {
  assert.deepEqual(chooseSalesStockAllocations(locations, 15, null), {
    error: "Only 14 units are available across active locations; 15 requested.",
  });
});

test("partial delivery consumption spans reservations and preserves location traceability", () => {
  assert.deepEqual(allocateReservationConsumption([
    { id: 12, locationId: 2, quantity: 4 },
    { id: 11, locationId: 1, quantity: 2 },
  ], 5), [
    { reservationId: 11, locationId: 1, quantity: 2 },
    { reservationId: 12, locationId: 2, quantity: 3 },
  ]);
});

test("delivery consumption fails when active reservations do not cover the requested quantity", () => {
  assert.equal(allocateReservationConsumption([{ id: 11, locationId: 1, quantity: 2 }], 3), null);
});

test("custom delivery allocations consume only the selected locations", () => {
  assert.deepEqual(allocateReservationConsumption([
    { id: 11, locationId: 1, quantity: 2 },
    { id: 12, locationId: 2, quantity: 4 },
  ], 3, [{ locationId: 2, quantity: 3 }]), [
    { reservationId: 12, locationId: 2, quantity: 3 },
  ]);
});

test("custom delivery allocations reject locations above their remaining reservation", () => {
  assert.equal(allocateReservationConsumption([
    { id: 11, locationId: 1, quantity: 2 },
    { id: 12, locationId: 2, quantity: 3 },
  ], 4, [{ locationId: 2, quantity: 4 }]), null);
});

test("custom delivery allocations must cover the full delivery quantity", () => {
  assert.equal(allocateReservationConsumption([
    { id: 11, locationId: 1, quantity: 2 },
    { id: 12, locationId: 2, quantity: 3 },
  ], 4, [{ locationId: 1, quantity: 2 }]), null);
});

test("custom delivery allocations reject locations not reserved for the order", () => {
  assert.equal(allocateReservationConsumption([
    { id: 11, locationId: 1, quantity: 2 },
  ], 1, [{ locationId: 99, quantity: 1 }]), null);
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
