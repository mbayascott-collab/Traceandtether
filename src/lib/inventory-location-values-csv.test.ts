import assert from "node:assert/strict";
import test from "node:test";
import { inventoryLocationValuesCsv, type InventoryLocationTotal } from "./api";

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
