import assert from "node:assert/strict";
import test from "node:test";
import { inventoryLocationValuesCsv, inventoryProductLocationCsv, type InventoryItem, type InventoryLocationTotal } from "./api";

const totals: InventoryLocationTotal[] = [
  { id: 1, name: "Main, east", onHand: 3, reserved: 0, available: 3, stockValueZmw: "12.10" },
  { id: 2, name: "Empty warehouse", onHand: 0, reserved: 0, available: 0, stockValueZmw: "0.00" },
  { id: null, name: "Unassigned", onHand: 1, reserved: 0, available: 1, stockValueZmw: "0.03" },
];

test("location value CSV preserves cents, includes zero locations, and adds an overall total", () => {
  const rows = inventoryLocationValuesCsv(totals).split("\r\n");

  assert.deepEqual(rows, [
    '"Location","Stock value (ZMW)"',
    '"Main, east","12.10"',
    '"Empty warehouse","0.00"',
    '"Unassigned","0.03"',
    '"Overall total","12.13"',
  ]);
});

test("location value CSV safely escapes location names without changing their balances", () => {
  const hostileName: InventoryLocationTotal = {
    id: 3, name: '=HYPERLINK("https://example.test","open")', onHand: 0, reserved: 0, available: 0, stockValueZmw: "0.00",
  };

  assert.equal(
    inventoryLocationValuesCsv([hostileName]).split("\r\n")[1],
    `"'\u003dHYPERLINK(""https://example.test"",""open"")","0.00"`,
  );
  assert.equal(hostileName.stockValueZmw, "0.00");
});

test("location value CSV totals negative cents exactly", () => {
  assert.equal(
    inventoryLocationValuesCsv([
      { id: 1, name: "Adjustment", onHand: 0, reserved: 0, available: 0, stockValueZmw: "-1.01" },
      { id: 2, name: "Remaining", onHand: 0, reserved: 0, available: 0, stockValueZmw: "0.10" },
    ]).split("\r\n").at(-1),
    '"Overall total","-0.91"',
  );
});

test("product-by-location CSV includes empty locations and exact product balances", () => {
  const inventory: InventoryItem[] = [{
    id: 12,
    name: "Leather bag",
    sku: "BAG-12",
    unit: "piece",
    status: "active",
    onHand: 3,
    reserved: 1,
    available: 2,
    stockValueZmw: "12.13",
    averageUnitCostZmw: "4.04",
    locations: [
      { id: 1, name: "Main, east", onHand: 3, reserved: 1, available: 2, stockValueZmw: "12.13" },
      { id: 2, name: "Empty warehouse", onHand: 0, reserved: 0, available: 0, stockValueZmw: "0.00" },
    ],
  }];

  assert.deepEqual(inventoryProductLocationCsv(inventory).split("\r\n"), [
    '"Product","SKU","Location","On hand","Reserved","Available","Stock value (ZMW)"',
    '"Leather bag","BAG-12","Main, east","3","1","2","12.13"',
    '"Leather bag","BAG-12","Empty warehouse","0","0","0","0.00"',
  ]);
});

test("product-by-location CSV protects formula-like product and location names", () => {
  const inventory: InventoryItem[] = [{
    id: 13,
    name: "=HYPERLINK(\"https://example.test\",\"open\")",
    sku: "SKU-13",
    unit: "piece",
    status: "active",
    onHand: 0,
    reserved: 0,
    available: 0,
    stockValueZmw: "0.00",
    averageUnitCostZmw: "0.00",
    locations: [
      { id: 3, name: "@warehouse", onHand: 0, reserved: 0, available: 0, stockValueZmw: "0.00" },
    ],
  }];

  assert.equal(
    inventoryProductLocationCsv(inventory).split("\r\n")[1],
    `"'=HYPERLINK(""https://example.test"",""open"")","SKU-13","'@warehouse","0","0","0","0.00"`,
  );
});
