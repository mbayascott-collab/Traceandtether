import assert from "node:assert/strict";
import test from "node:test";
import { salesDeliveryLocationCsv, type SalesOrder } from "./api";

const orders: SalesOrder[] = [{
  id: 1,
  orderNumber: "SO-001",
  customerId: 9,
  customerName: "Mwamba Family",
  status: "partially_fulfilled",
  orderDate: "2025-02-10",
  confirmedAt: "2025-02-10",
  fulfilledAt: null,
  deliveryAddress: null,
  notes: null,
  totalZmw: "100.00",
  deliveredZmw: "40.00",
  campaignId: null,
  campaignName: null,
  lines: [],
  deliveries: [{
    id: 11,
    deliveryNumber: "DN-001",
    deliveryDate: "2025-02-12",
    totalZmw: "40.00",
    receipt: null,
    lines: [{
      salesDeliveryLineId: 12,
      salesOrderLineId: 13,
      productName: "Leather bag",
      sku: "BAG-1",
      quantity: 4,
      returnedQuantity: 0,
      returns: [],
      stockLocations: [
        { locationId: 1, locationName: "Main, east", quantity: 3 },
        { locationId: null, locationName: null, quantity: 1 },
      ],
      unitPriceZmw: "10.00",
      lineTotalZmw: "40.00",
    }],
  }],
}];

test("warehouse delivery CSV matches delivery lines and their recorded locations", () => {
  assert.deepEqual(salesDeliveryLocationCsv(orders).split("\r\n"), [
    '"Delivery date","Delivery","Order","Customer","Product","SKU","Stock location","Delivered quantity"',
    '"2025-02-12","DN-001","SO-001","Mwamba Family","Leather bag","BAG-1","Main, east","3"',
    '"2025-02-12","DN-001","SO-001","Mwamba Family","Leather bag","BAG-1","Unassigned","1"',
  ]);
});

test("warehouse delivery CSV protects spreadsheet formula-like names", () => {
  const rows = salesDeliveryLocationCsv([{
    ...orders[0]!,
    customerName: "=HYPERLINK(\"https://example.test\",\"open\")",
  }]).split("\r\n");

  assert.equal(
    rows[1],
    `"2025-02-12","DN-001","SO-001","'=HYPERLINK(""https://example.test"",""open"")","Leather bag","BAG-1","Main, east","3"`,
  );
});
