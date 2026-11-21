import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test, { after } from "node:test";
import { and, eq, inArray, sum } from "drizzle-orm";
import {
  inventoryLocations, inventoryMovements, products, purchaseOrders, purchaseOrderLines, shipmentLines as shipmentLineRows,
  shipmentPurchaseOrders, shipments as shipmentHeaders, suppliers,
} from "../shared/schema";
import { calculatePurchaseReceiptPosting, journalLinesAreBalanced } from "./accounting-posting";
import {
  purchaseOrderReceiptStatus, shipmentReceiptStatus, validateShipmentReceipt,
} from "./shipment-receiving";

after(async () => {
  if (process.env.DATABASE_URL) {
    const { pool } = await import("./db");
    await pool.end();
  }
});

const shipmentLines = [
  { id: 11, purchaseOrderLineId: 101, quantityShipped: 4, quantityStocked: 0 },
  { id: 12, purchaseOrderLineId: 202, quantityShipped: 2, quantityStocked: 0 },
];
const orderLines = [
  { id: 101, purchaseOrderId: 1, quantityOrdered: 4 },
  { id: 202, purchaseOrderId: 2, quantityOrdered: 2 },
];

function validationError(
  requestedQuantities: Map<number, number>,
  options: { priorReceipts?: Map<number, number>; orderStatuses?: Map<number, string> } = {},
) {
  return validateShipmentReceipt({
    shipmentLines,
    requestedQuantities,
    purchaseOrderLines: orderLines,
    otherReceivedByLine: options.priorReceipts ?? new Map(),
    purchaseOrderStatuses: options.orderStatuses ?? new Map([[1, "ordered"], [2, "ordered"]]),
  });
}

test("accepts a partial receipt for a consolidated shipment and keeps each order partially received", () => {
  const partial = [{ quantityReceived: 2 }, { quantityReceived: 1 }];
  assert.equal(validationError(new Map([[11, 2], [12, 1]])), null);
  assert.equal(shipmentReceiptStatus(partial, shipmentLines), "partially_received");
  assert.equal(purchaseOrderReceiptStatus([orderLines[0]!], new Map([[101, 2]])), "partially_received");
  assert.equal(purchaseOrderReceiptStatus([orderLines[1]!], new Map([[202, 1]])), "partially_received");
});

test("accepts a full receipt and marks every purchase order received", () => {
  const full = [{ quantityReceived: 4 }, { quantityReceived: 2 }];
  assert.equal(validationError(new Map([[11, 4], [12, 2]])), null);
  assert.equal(shipmentReceiptStatus(full, shipmentLines), "received");
  assert.equal(purchaseOrderReceiptStatus([orderLines[0]!], new Map([[101, 4]])), "received");
  assert.equal(purchaseOrderReceiptStatus([orderLines[1]!], new Map([[202, 2]])), "received");
});

test("rejects quantities beyond shipped or ordered amounts and protects cancelled orders", () => {
  assert.match(validationError(new Map([[11, 5], [12, 0]])) ?? "", /quantity shipped/);
  assert.match(
    validationError(new Map([[11, 2], [12, 0]]), { priorReceipts: new Map([[101, 3]]) }) ?? "",
    /quantity ordered/,
  );
  assert.match(
    validationError(new Map([[11, 1], [12, 1]]), { orderStatuses: new Map([[1, "cancelled"], [2, "ordered"]]) }) ?? "",
    /cancelled/i,
  );
});

test("rejects reducing a receipt below the quantity already posted to stock", () => {
  const error = validateShipmentReceipt({
    shipmentLines: [{ ...shipmentLines[0]!, quantityStocked: 2 }],
    requestedQuantities: new Map([[11, 1]]),
    purchaseOrderLines: [orderLines[0]!],
    otherReceivedByLine: new Map(),
    purchaseOrderStatuses: new Map([[1, "ordered"]]),
  });

  assert.match(error ?? "", /cannot be reduced below the quantity already posted to stock/i);
});

test("keeps the saved receipt quantity when a correction would remove stocked units", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerProcurementRoutes }] = await Promise.all([
    import("./db"),
    import("./procurement-routes"),
  ]);
  const auditTable = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
  );
  if (!auditTable.rows[0]?.exists) {
    t.skip("requires the business audit migration used by the receiving route");
    return;
  }
  const suffix = randomUUID();
  const actorEmail = `shipment-receipt-correction-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerProcurementRoutes(app, owner);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let supplierId: number | undefined;
  let productId: number | undefined;
  let secondProductId: number | undefined;
  let purchaseOrderId: number | undefined;
  try {
    const [supplier] = await db.insert(suppliers).values({ name: `Receipt correction supplier ${suffix}` }).returning();
    supplierId = supplier.id;
    const [product, secondProduct] = await db.insert(products).values([
      { sku: `RCC-${suffix}`, name: `Receipt correction product ${suffix}`, status: "active", purchaseCurrency: "CNY" },
      { sku: `RCC-2-${suffix}`, name: `Receipt correction second product ${suffix}`, status: "active", purchaseCurrency: "CNY" },
    ]).returning();
    productId = product.id;
    secondProductId = secondProduct.id;

    const orderResponse = await fetch(`${baseUrl}/api/purchase-orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        supplierId, currency: "CNY", exchangeRateToZmw: "2", expectedAt: null, notes: null,
        lines: [
          { productId, quantityOrdered: 5, unitPrice: "10.00" },
          { productId: secondProductId, quantityOrdered: 2, unitPrice: "15.00" },
        ],
      }),
    });
    assert.equal(orderResponse.status, 201);
    const { order } = await orderResponse.json() as { order: { id: number } };
    purchaseOrderId = order.id;
    const orderLines = await db.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId));
    const firstOrderLine = orderLines.find((line) => line.productId === productId)!;
    const secondOrderLine = orderLines.find((line) => line.productId === secondProductId)!;

    const [shipment] = await db.insert(shipmentHeaders).values({
      purchaseOrderId, shipmentReference: `RCC-${suffix}`,
    }).returning();
    await db.insert(shipmentPurchaseOrders).values({ shipmentId: shipment.id, purchaseOrderId });
    const [firstShipmentLine, secondShipmentLine] = await db.insert(shipmentLineRows).values([
      {
        shipmentId: shipment.id, purchaseOrderLineId: firstOrderLine.id,
        quantityShipped: 5, quantityReceived: 5, quantityStocked: 2,
      },
      {
        shipmentId: shipment.id, purchaseOrderLineId: secondOrderLine.id,
        quantityShipped: 2, quantityReceived: 2, quantityStocked: 2,
      },
    ]).returning();

    const blockedCorrectionResponse = await fetch(`${baseUrl}/api/shipments/${shipment.id}/receive`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines: [
        { shipmentLineId: firstShipmentLine.id, quantityReceived: 3 },
        { shipmentLineId: secondShipmentLine.id, quantityReceived: 1 },
      ] }),
    });
    assert.equal(blockedCorrectionResponse.status, 400);
    const [firstLineAfterRejectedCorrection, secondLineAfterRejectedCorrection] = await Promise.all([
      db.select({ quantityReceived: shipmentLineRows.quantityReceived }).from(shipmentLineRows)
        .where(eq(shipmentLineRows.id, firstShipmentLine.id)),
      db.select({ quantityReceived: shipmentLineRows.quantityReceived }).from(shipmentLineRows)
        .where(eq(shipmentLineRows.id, secondShipmentLine.id)),
    ]);
    assert.deepEqual(
      [firstLineAfterRejectedCorrection[0]?.quantityReceived, secondLineAfterRejectedCorrection[0]?.quantityReceived],
      [5, 2],
      "a blocked line must not partially save another line's valid correction",
    );

    const correctionResponse = await fetch(`${baseUrl}/api/shipments/${shipment.id}/receive`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines: [
        { shipmentLineId: firstShipmentLine.id, quantityReceived: 3 },
        { shipmentLineId: secondShipmentLine.id, quantityReceived: 2 },
      ] }),
    });
    assert.equal(correctionResponse.status, 200);
    const correctedPayload = await correctionResponse.json() as { shipment: { status: string } };
    assert.equal(correctedPayload.shipment.status, "partially_received");
    const [correctedOrder] = await db.select({ status: purchaseOrders.status })
      .from(purchaseOrders).where(eq(purchaseOrders.id, purchaseOrderId));
    assert.equal(correctedOrder.status, "partially_received");

    const response = await fetch(`${baseUrl}/api/shipments/${shipment.id}/receive`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines: [
        { shipmentLineId: firstShipmentLine.id, quantityReceived: 1 },
        { shipmentLineId: secondShipmentLine.id, quantityReceived: 2 },
      ] }),
    });
    const payload = await response.json() as { error?: string };
    assert.equal(response.status, 400);
    assert.match(payload.error ?? "", /cannot be reduced below the quantity already posted to stock/i);

    const savedLines = await db.select({
      id: shipmentLineRows.id, quantityReceived: shipmentLineRows.quantityReceived,
    }).from(shipmentLineRows).where(eq(shipmentLineRows.shipmentId, shipment.id));
    assert.deepEqual(
      savedLines.map(({ id, quantityReceived }) => [id, quantityReceived]),
      [[firstShipmentLine.id, 3], [secondShipmentLine.id, 2]],
    );
  } finally {
    try {
      await pool.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      if (purchaseOrderId) {
        await pool.query(
          "DELETE FROM shipment_lines WHERE shipment_id IN (SELECT id FROM shipments WHERE purchase_order_id = $1)",
          [purchaseOrderId],
        );
        await pool.query(
          "DELETE FROM shipment_purchase_orders WHERE purchase_order_id = $1",
          [purchaseOrderId],
        );
        await pool.query("DELETE FROM shipments WHERE purchase_order_id = $1", [purchaseOrderId]);
        await pool.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1", [purchaseOrderId]);
        await pool.query("DELETE FROM purchase_orders WHERE id = $1", [purchaseOrderId]);
      }
      if (productId) await pool.query("DELETE FROM products WHERE id = $1", [productId]);
      if (secondProductId) await pool.query("DELETE FROM products WHERE id = $1", [secondProductId]);
      if (supplierId) await pool.query("DELETE FROM suppliers WHERE id = $1", [supplierId]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});

test("concurrent receipts respect the remaining balance of a partially delivered order", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerProcurementRoutes }] = await Promise.all([
    import("./db"),
    import("./procurement-routes"),
  ]);
  const auditTable = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
  );
  if (!auditTable.rows[0]?.exists) {
    t.skip("requires the business audit migration used by the receiving route");
    return;
  }
  const suffix = randomUUID();
  const actorEmail = `shipment-receiving-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerProcurementRoutes(app, owner);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let supplierId: number | undefined;
  let productId: number | undefined;
  let purchaseOrderId: number | undefined;
  try {
    const [supplier] = await db.insert(suppliers).values({ name: `Receipt concurrency supplier ${suffix}` }).returning();
    supplierId = supplier.id;
    const [product] = await db.insert(products).values({
      sku: `RCV-${suffix}`, name: `Receipt concurrency product ${suffix}`, status: "active", purchaseCurrency: "CNY",
    }).returning();
    productId = product.id;

    const orderResponse = await fetch(`${baseUrl}/api/purchase-orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        supplierId, currency: "CNY", exchangeRateToZmw: "2", expectedAt: null, notes: null,
        lines: [{ productId, quantityOrdered: 5, unitPrice: "10.00" }],
      }),
    });
    const { order } = await orderResponse.json() as { order: { id: number } };
    assert.equal(orderResponse.status, 201);
    purchaseOrderId = order.id;
    const [orderLine] = await db.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId));

    // The order already has a partial delivery; both concurrent shipments compete for its remaining balance.
    const createdShipments = await db.transaction(async (tx) => {
      const rows = [];
      const [priorShipment] = await tx.insert(shipmentHeaders).values({
        purchaseOrderId: purchaseOrderId!, shipmentReference: `RCV-${suffix}-prior`, status: "partially_received",
      }).returning();
      await tx.insert(shipmentPurchaseOrders).values({
        shipmentId: priorShipment.id, purchaseOrderId: purchaseOrderId!,
      });
      await tx.insert(shipmentLineRows).values({
        shipmentId: priorShipment.id, purchaseOrderLineId: orderLine.id,
        quantityShipped: 2, quantityReceived: 2,
      });
      for (let index = 0; index < 2; index += 1) {
        const [shipment] = await tx.insert(shipmentHeaders).values({
          purchaseOrderId: purchaseOrderId!, shipmentReference: `RCV-${suffix}-${index}`,
        }).returning();
        await tx.insert(shipmentPurchaseOrders).values({ shipmentId: shipment.id, purchaseOrderId: purchaseOrderId! });
        const [line] = await tx.insert(shipmentLineRows).values({
          shipmentId: shipment.id, purchaseOrderLineId: orderLine.id, quantityShipped: 3, quantityReceived: 0,
        }).returning();
        rows.push({ id: shipment.id, lineId: line.id });
      }
      return rows;
    });

    const responses = await Promise.all(createdShipments.map(({ id, lineId }) => fetch(
      `${baseUrl}/api/shipments/${id}/receive`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lines: [{ shipmentLineId: lineId, quantityReceived: 3 }] }),
      },
    )));
    const payloads = await Promise.all(responses.map((response) => response.json() as Promise<{ error?: string }>));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
    assert.match(payloads.find((payload) => payload.error)?.error ?? "", /quantity ordered/i);

    const [receiptTotal] = await db.select({ quantity: sum(shipmentLineRows.quantityReceived) })
      .from(shipmentLineRows).where(eq(shipmentLineRows.purchaseOrderLineId, orderLine.id));
    assert.equal(Number(receiptTotal.quantity), 5);
  } finally {
    try {
      await pool.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      if (purchaseOrderId) {
        await pool.query(
          "DELETE FROM shipment_lines WHERE shipment_id IN (SELECT id FROM shipments WHERE purchase_order_id = $1)",
          [purchaseOrderId],
        );
        await pool.query(
          "DELETE FROM shipment_purchase_orders WHERE purchase_order_id = $1",
          [purchaseOrderId],
        );
        await pool.query("DELETE FROM shipments WHERE purchase_order_id = $1", [purchaseOrderId]);
        await pool.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1", [purchaseOrderId]);
        await pool.query("DELETE FROM purchase_orders WHERE id = $1", [purchaseOrderId]);
      }
      if (productId) await pool.query("DELETE FROM products WHERE id = $1", [productId]);
      if (supplierId) await pool.query("DELETE FROM suppliers WHERE id = $1", [supplierId]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});

test("rejects one of two concurrent shipments that exceed the purchase-order quantity", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerProcurementRoutes }] = await Promise.all([
    import("./db"),
    import("./procurement-routes"),
  ]);
  const auditTable = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
  );
  if (!auditTable.rows[0]?.exists) {
    t.skip("requires the business audit migration used by the shipment route");
    return;
  }
  const suffix = randomUUID();
  const actorEmail = `shipment-create-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerProcurementRoutes(app, owner);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let supplierId: number | undefined;
  let productId: number | undefined;
  let purchaseOrderId: number | undefined;
  try {
    const [supplier] = await db.insert(suppliers).values({ name: `Shipment concurrency supplier ${suffix}` }).returning();
    supplierId = supplier.id;
    const [product] = await db.insert(products).values({
      sku: `SHP-${suffix}`, name: `Shipment concurrency product ${suffix}`, status: "active", purchaseCurrency: "CNY",
    }).returning();
    productId = product.id;

    const orderResponse = await fetch(`${baseUrl}/api/purchase-orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        supplierId, currency: "CNY", exchangeRateToZmw: "2", expectedAt: null, notes: null,
        lines: [{ productId, quantityOrdered: 5, unitPrice: "10.00" }],
      }),
    });
    assert.equal(orderResponse.status, 201);
    const { order } = await orderResponse.json() as { order: { id: number } };
    purchaseOrderId = order.id;
    const [orderLine] = await db.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId));

    const responses = await Promise.all([0, 1].map((index) => fetch(`${baseUrl}/api/shipments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        purchaseOrderIds: [purchaseOrderId],
        shipmentReference: `SHP-${suffix}-${index}`,
        carrier: null,
        trackingNumber: null,
        shippedAt: null,
        expectedAt: null,
        notes: null,
        lines: [{ purchaseOrderLineId: orderLine.id, quantityShipped: 3 }],
      }),
    })));
    const payloads = await Promise.all(responses.map((response) => response.json() as Promise<{ error?: string }>));
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 400]);
    assert.match(payloads.find((payload) => payload.error)?.error ?? "", /quantity ordered/i);

    const [shippedTotal] = await db.select({ quantity: sum(shipmentLineRows.quantityShipped) })
      .from(shipmentLineRows).where(eq(shipmentLineRows.purchaseOrderLineId, orderLine.id));
    assert.equal(Number(shippedTotal.quantity), 3);
  } finally {
    try {
      await pool.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      if (purchaseOrderId) {
        await pool.query(
          "DELETE FROM shipment_lines WHERE shipment_id IN (SELECT id FROM shipments WHERE purchase_order_id = $1)",
          [purchaseOrderId],
        );
        await pool.query(
          "DELETE FROM shipment_purchase_orders WHERE purchase_order_id = $1",
          [purchaseOrderId],
        );
        await pool.query("DELETE FROM shipments WHERE purchase_order_id = $1", [purchaseOrderId]);
        await pool.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1", [purchaseOrderId]);
        await pool.query("DELETE FROM purchase_orders WHERE id = $1", [purchaseOrderId]);
      }
      if (productId) await pool.query("DELETE FROM products WHERE id = $1", [productId]);
      if (supplierId) await pool.query("DELETE FROM suppliers WHERE id = $1", [supplierId]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});

test("concurrent consolidated shipments stay within every shared order line", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerProcurementRoutes }] = await Promise.all([
    import("./db"),
    import("./procurement-routes"),
  ]);
  const auditTable = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
  );
  if (!auditTable.rows[0]?.exists) {
    t.skip("requires the business audit migration used by the shipment route");
    return;
  }

  const suffix = randomUUID();
  const actorEmail = `consolidated-shipment-race-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerProcurementRoutes(app, owner);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let supplierId: number | undefined;
  const productIds: number[] = [];
  const purchaseOrderIds: number[] = [];
  try {
    const [supplier] = await db.insert(suppliers).values({
      name: `Consolidated shipment race supplier ${suffix}`,
    }).returning();
    supplierId = supplier.id;
    const productRows = await db.insert(products).values([
      { sku: `CSR-1-${suffix}`, name: `Consolidated race product one ${suffix}`, status: "active", purchaseCurrency: "CNY" },
      { sku: `CSR-2-${suffix}`, name: `Consolidated race product two ${suffix}`, status: "active", purchaseCurrency: "CNY" },
    ]).returning();
    productIds.push(...productRows.map(({ id }) => id));
    const orderLines: { purchaseOrderId: number; lineId: number }[] = [];
    for (const [index, product] of productRows.entries()) {
      const orderResponse: Response = await fetch(`${baseUrl}/api/purchase-orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          supplierId, currency: "CNY", exchangeRateToZmw: "2", expectedAt: null, notes: null,
          lines: [{ productId: product.id, quantityOrdered: 5, unitPrice: "10.00" }],
        }),
      });
      const orderPayload = await orderResponse.json() as { order?: { id: number }; error?: string };
      assert.equal(orderResponse.status, 201, JSON.stringify(orderPayload));
      assert.ok(orderPayload.order);
      const { order } = orderPayload as { order: { id: number } };
      purchaseOrderIds.push(order.id);
      const [line] = await db.select().from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.purchaseOrderId, order.id));
      assert.ok(line, `purchase order ${index + 1} should have a line`);
      orderLines.push({ purchaseOrderId: order.id, lineId: line.id });
    }

    const shipmentBody = (index: number, reverse: boolean) => ({
      purchaseOrderIds: reverse ? [...purchaseOrderIds].reverse() : purchaseOrderIds,
      shipmentReference: `CSR-${suffix}-${index}`,
      carrier: null,
      trackingNumber: null,
      shippedAt: null,
      expectedAt: null,
      notes: null,
      lines: (reverse ? [...orderLines].reverse() : orderLines).map(({ lineId }) => ({
        purchaseOrderLineId: lineId, quantityShipped: 3,
      })),
    });
    const responses = await Promise.all([0, 1].map((index) => fetch(`${baseUrl}/api/shipments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify(shipmentBody(index, index === 1)),
    })));
    const payloads = await Promise.all(responses.map((response) => response.json() as Promise<{ error?: string }>));
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 400], JSON.stringify(payloads));
    assert.match(payloads.find((payload) => payload.error)?.error ?? "", /quantity ordered/i);

    const persistedLines = await db.select({
      purchaseOrderLineId: shipmentLineRows.purchaseOrderLineId,
      quantityShipped: shipmentLineRows.quantityShipped,
    }).from(shipmentLineRows).where(inArray(
      shipmentLineRows.purchaseOrderLineId,
      orderLines.map(({ lineId }) => lineId),
    ));
    const quantitiesByOrderLine = new Map<number, number>();
    persistedLines.forEach((line) => quantitiesByOrderLine.set(
      line.purchaseOrderLineId,
      (quantitiesByOrderLine.get(line.purchaseOrderLineId) ?? 0) + line.quantityShipped,
    ));
    assert.equal(quantitiesByOrderLine.size, orderLines.length);
    for (const { lineId } of orderLines) {
      assert.equal(quantitiesByOrderLine.get(lineId), 3, `line ${lineId} must not exceed its ordered quantity`);
    }
  } finally {
    try {
      await pool.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      if (purchaseOrderIds.length) {
        await pool.query(`
          DELETE FROM shipment_lines
          WHERE shipment_id IN (
            SELECT id FROM shipments
            WHERE purchase_order_id = ANY($1::int[])
              OR id IN (SELECT shipment_id FROM shipment_purchase_orders WHERE purchase_order_id = ANY($1::int[]))
          )
        `, [purchaseOrderIds]);
        await pool.query("DELETE FROM shipment_purchase_orders WHERE purchase_order_id = ANY($1::int[])", [purchaseOrderIds]);
        await pool.query(`
          DELETE FROM shipments
          WHERE purchase_order_id = ANY($1::int[])
            OR id IN (SELECT shipment_id FROM shipment_purchase_orders WHERE purchase_order_id = ANY($1::int[]))
        `, [purchaseOrderIds]);
        await pool.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = ANY($1::int[])", [purchaseOrderIds]);
        await pool.query("DELETE FROM purchase_orders WHERE id = ANY($1::int[])", [purchaseOrderIds]);
      }
      if (productIds.length) await pool.query("DELETE FROM products WHERE id = ANY($1::int[])", [productIds]);
      if (supplierId) await pool.query("DELETE FROM suppliers WHERE id = $1", [supplierId]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});

test("inactive locations reject received shipment stock without changing quantities", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerProcurementRoutes }, { registerInventoryRoutes }] = await Promise.all([
    import("./db"),
    import("./procurement-routes"),
    import("./inventory-routes"),
  ]);
  const auditTable = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
  );
  if (!auditTable.rows[0]?.exists) {
    t.skip("requires the business audit migration used by the shipment route");
    return;
  }

  const suffix = randomUUID();
  const actorEmail = `inactive-receipt-location-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerProcurementRoutes(app, owner);
  registerInventoryRoutes(app, owner);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let supplierId: number | undefined;
  let productId: number | undefined;
  let purchaseOrderId: number | undefined;
  let shipmentId: number | undefined;
  let inactiveLocationId: number | undefined;
  try {
    const [supplier] = await db.insert(suppliers).values({ name: `Inactive receipt supplier ${suffix}` }).returning();
    supplierId = supplier.id;
    const [product] = await db.insert(products).values({
      sku: `IRL-${suffix}`, name: `Inactive receipt product ${suffix}`, status: "active", purchaseCurrency: "CNY",
    }).returning();
    productId = product.id;
    const [inactiveLocation] = await db.insert(inventoryLocations).values({
      name: `Inactive receiving location ${suffix}`, active: false,
    }).returning();
    inactiveLocationId = inactiveLocation.id;

    const orderResponse = await fetch(`${baseUrl}/api/purchase-orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        supplierId, currency: "CNY", exchangeRateToZmw: "2", expectedAt: null, notes: null,
        lines: [{ productId, quantityOrdered: 5, unitPrice: "10.00" }],
      }),
    });
    const orderPayload = await orderResponse.json() as any;
    assert.equal(orderResponse.status, 201, JSON.stringify(orderPayload));
    const createdPurchaseOrderId = orderPayload.order.id as number;
    purchaseOrderId = createdPurchaseOrderId;
    const [orderLine] = await db.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, createdPurchaseOrderId));
    assert.ok(orderLine);

    const shipmentResponse = await fetch(`${baseUrl}/api/shipments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        purchaseOrderIds: [purchaseOrderId],
        shipmentReference: `IRL-${suffix}`,
        carrier: null, trackingNumber: null, shippedAt: null, expectedAt: null, notes: null,
        lines: [{ purchaseOrderLineId: orderLine.id, quantityShipped: 5 }],
      }),
    });
    const shipmentPayload = await shipmentResponse.json() as any;
    assert.equal(shipmentResponse.status, 201, JSON.stringify(shipmentPayload));
    const createdShipmentId = shipmentPayload.shipment.id as number;
    shipmentId = createdShipmentId;
    const [shipmentLine] = await db.select().from(shipmentLineRows)
      .where(eq(shipmentLineRows.shipmentId, createdShipmentId));
    assert.ok(shipmentLine);

    const receivedResponse = await fetch(`${baseUrl}/api/shipments/${createdShipmentId}/receive`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines: [{ shipmentLineId: shipmentLine.id, quantityReceived: 5 }] }),
    });
    assert.equal(receivedResponse.status, 200, await receivedResponse.text());

    const postResponse = await fetch(`${baseUrl}/api/inventory/receipts/${shipmentLine.id}/post`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locationId: inactiveLocationId }),
    });
    const postPayload = await postResponse.json() as { error?: string };
    assert.equal(postResponse.status, 400, JSON.stringify(postPayload));
    assert.match(postPayload.error ?? "", /active receiving location/i);

    const [persistedLine] = await db.select().from(shipmentLineRows)
      .where(eq(shipmentLineRows.id, shipmentLine.id));
    assert.equal(persistedLine?.quantityReceived, 5);
    assert.equal(persistedLine?.quantityStocked, 0);
    const receiptMovements = await db.select().from(inventoryMovements)
      .where(and(
        eq(inventoryMovements.productId, productId),
        eq(inventoryMovements.kind, "stock_receipt"),
      ));
    assert.equal(receiptMovements.length, 0);
  } finally {
    try {
      await pool.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      if (shipmentId) {
        await pool.query("DELETE FROM shipment_lines WHERE shipment_id = $1", [shipmentId]);
        await pool.query("DELETE FROM shipment_purchase_orders WHERE shipment_id = $1", [shipmentId]);
        await pool.query("DELETE FROM shipments WHERE id = $1", [shipmentId]);
      }
      if (purchaseOrderId) {
        await pool.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1", [purchaseOrderId]);
        await pool.query("DELETE FROM purchase_orders WHERE id = $1", [purchaseOrderId]);
      }
      if (productId) {
        await pool.query("DELETE FROM inventory_movements WHERE product_id = $1", [productId]);
        await pool.query("DELETE FROM products WHERE id = $1", [productId]);
      }
      if (inactiveLocationId) await pool.query("DELETE FROM inventory_locations WHERE id = $1", [inactiveLocationId]);
      if (supplierId) await pool.query("DELETE FROM suppliers WHERE id = $1", [supplierId]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});

test("posts each consolidated receipt at its own order-line cost", () => {
  const supplierOne = calculatePurchaseReceiptPosting({
    productId: 31, quantity: 2, unitPrice: "10.00", exchangeRateToZmw: "2.00000000",
    quantityOrdered: 4, quantityPreviouslyStocked: 0, allocatedExpensesZmw: "8.00",
  });
  const supplierTwo = calculatePurchaseReceiptPosting({
    productId: 47, quantity: 1, unitPrice: "3.50", exchangeRateToZmw: "10.00000000",
    quantityOrdered: 2, quantityPreviouslyStocked: 0, allocatedExpensesZmw: "6.00",
  });

  assert.equal(supplierOne.goodsCost, 4_000n);
  assert.equal(supplierOne.landedCost, 400n);
  assert.deepEqual(supplierOne.lines.map((line) => [line.accountKey, line.productId, line.debitZmw, line.creditZmw]), [
    ["inventory", 31, "44.00", undefined],
    ["accounts_payable", undefined, undefined, "40.00"],
    ["landed_cost_clearing", undefined, undefined, "4.00"],
  ]);
  assert.equal(supplierTwo.goodsCost, 3_500n);
  assert.equal(supplierTwo.landedCost, 300n);
  assert.deepEqual(supplierTwo.lines.map((line) => [line.accountKey, line.productId, line.debitZmw, line.creditZmw]), [
    ["inventory", 47, "38.00", undefined],
    ["accounts_payable", undefined, undefined, "35.00"],
    ["landed_cost_clearing", undefined, undefined, "3.00"],
  ]);
  assert.equal(journalLinesAreBalanced(supplierOne.lines), true);
  assert.equal(journalLinesAreBalanced(supplierTwo.lines), true);
});
