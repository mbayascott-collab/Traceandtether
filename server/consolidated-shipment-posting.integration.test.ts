import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test from "node:test";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  accountingAccounts, importExpenses, inventoryLocations, inventoryMovements, journalEntries, journalLines,
  products, purchaseOrderLines, shipments, shipmentLines, suppliers,
} from "../shared/schema";
import { cents, formatCents, journalLinesAreBalanced } from "./accounting-posting";

test("posts staged consolidated shipment receipts by increment with balanced journals", {
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
    await pool.end();
    t.skip("requires the business audit migration used by shipment routes");
    return;
  }

  const suffix = randomUUID();
  const actorEmail = `consolidated-shipment-${suffix}@example.test`;
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

  const supplierIds: number[] = [];
  const productIds: number[] = [];
  const purchaseOrderIds: number[] = [];
  let locationId: number | undefined;
  let shipmentId: number | undefined;
  const request = async (
    method: "GET" | "POST" | "PATCH",
    path: string,
    body: unknown,
    expectedStatus: number,
  ) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json() as any;
    assert.equal(response.status, expectedStatus, JSON.stringify(payload));
    return payload;
  };

  try {
    const [location] = await db.insert(inventoryLocations).values({
      name: `Consolidated shipment location ${suffix}`,
    }).returning();
    locationId = location.id;

    const orderSpecifications = [
      { currency: "CNY", exchangeRateToZmw: "2", quantity: 4, unitPrice: "10.00", expectedCost: "80.00" },
      { currency: "USD", exchangeRateToZmw: "10", quantity: 2, unitPrice: "5.00", expectedCost: "100.00" },
    ];
    const createdOrderLines: Array<{ id: number; quantity: number; expectedCost: string }> = [];
    for (const [index, specification] of orderSpecifications.entries()) {
      const [supplier] = await db.insert(suppliers).values({
        name: `Consolidated shipment supplier ${index + 1} ${suffix}`,
      }).returning();
      supplierIds.push(supplier.id);
      const [product] = await db.insert(products).values({
        sku: `CSHIP-${index + 1}-${suffix}`,
        name: `Consolidated shipment product ${index + 1} ${suffix}`,
        status: "active",
        purchaseCurrency: specification.currency,
      }).returning();
      productIds.push(product.id);

      const { order } = await request("POST", "/api/purchase-orders", {
        supplierId: supplier.id,
        currency: specification.currency,
        exchangeRateToZmw: specification.exchangeRateToZmw,
        expectedAt: null,
        notes: null,
        lines: [{
          productId: product.id,
          quantityOrdered: specification.quantity,
          unitPrice: specification.unitPrice,
        }],
      }, 201);
      purchaseOrderIds.push(order.id);
      const [orderLine] = await db.select().from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.purchaseOrderId, order.id));
      createdOrderLines.push({
        id: orderLine.id,
        quantity: specification.quantity,
        expectedCost: specification.expectedCost,
      });
    }

    const { shipment } = await request("POST", "/api/shipments", {
      purchaseOrderIds,
      shipmentReference: `CSHIP-${suffix}`,
      carrier: null,
      trackingNumber: null,
      shippedAt: null,
      expectedAt: null,
      notes: null,
      lines: createdOrderLines.map(({ id, quantity }) => ({
        purchaseOrderLineId: id,
        quantityShipped: quantity,
      })),
    }, 201);
    shipmentId = shipment.id;
    const { expense } = await request("POST", "/api/import-expenses", {
      purchaseOrderId: null,
      shipmentId,
      category: "Freight",
      description: `Shared consolidated freight ${suffix}`,
      amount: "12.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-11-19",
      reference: `FW-${suffix}`,
      notes: null,
    }, 201);

    const landedCostByOrder = await Promise.all(purchaseOrderIds.map(async (purchaseOrderId) => {
      const { orders } = await request(
        "GET",
        `/api/landed-costs?purchaseOrderId=${purchaseOrderId}`,
        undefined,
        200,
      );
      assert.equal(orders.length, 1);
      return [purchaseOrderId, orders[0].lines[0].allocatedExpensesZmw] as const;
    }));
    assert.deepEqual(landedCostByOrder.map(([, amount]) => amount), ["53.33", "66.67"]);
    const sharedExpenses = await db.select().from(importExpenses).where(eq(importExpenses.shipmentId, shipment.id));
    assert.equal(sharedExpenses.length, 1, "the consolidated shipment should have one shared freight expense");
    assert.equal(sharedExpenses[0]!.id, expense.id);

    const expenseEntries = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "import_expense"),
      eq(journalEntries.sourceId, expense.id),
    ));
    assert.equal(expenseEntries.length, 1, "the shared bill should create one payable journal");
    const expenseJournalLines = await db.select({
      accountKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalLines.journalEntryId, expenseEntries[0]!.id));
    assert.equal(journalLinesAreBalanced(expenseJournalLines.map((line) => ({
      accountKey: line.accountKey ?? "",
      debitZmw: line.debitZmw,
      creditZmw: line.creditZmw,
    }))), true, "the freight payable journal should balance");
    assert.deepEqual(expenseJournalLines.map((line) => [
      line.accountKey, line.debitZmw, line.creditZmw,
    ]).sort(([left], [right]) => String(left).localeCompare(String(right))), [
      ["accounts_payable", "0.00", "120.00"],
      ["landed_cost_clearing", "120.00", "0.00"],
    ].sort(([left], [right]) => String(left).localeCompare(String(right))));

    const receivedLines = await db.select().from(shipmentLines)
      .where(eq(shipmentLines.shipmentId, shipment.id))
      .orderBy(asc(shipmentLines.id));
    const receiptQueue = async () => {
      const { receipts } = await request("GET", "/api/inventory/receipts", undefined, 200);
      return receipts.filter((line: any) => receivedLines.some((receiptLine) => receiptLine.id === line.id));
    };
    assert.equal(receivedLines.length, 2);
    assert.deepEqual(
      receivedLines.map((line) => line.purchaseOrderLineId).sort(),
      createdOrderLines.map((line) => line.id).sort(),
    );

    const partialQuantities = [2, 1];
    const { shipment: partialShipment } = await request("PATCH", `/api/shipments/${shipmentId}/receive`, {
      lines: receivedLines.map((line, index) => ({
        shipmentLineId: line.id,
        quantityReceived: partialQuantities[index],
      })),
    }, 200);
    assert.equal(partialShipment.status, "partially_received");
    const partialQueue = await receiptQueue();
    assert.deepEqual(
      partialQueue.map((line: any) => [line.id, line.quantityToPost]).sort((a: number[], b: number[]) => a[0]! - b[0]!),
      receivedLines.map((line, index) => [line.id, partialQuantities[index]]).sort((a, b) => a[0]! - b[0]!),
    );

    const allocatedExpenseByLine = new Map(createdOrderLines.map((line, index) => [
      line.id, cents(["53.33", "66.67"][index]!),
    ]));
    const stockedByOrderLine = new Map(createdOrderLines.map((line) => [line.id, 0]));
    const posted = [];
    const firstReceiptLine = receivedLines[0]!;
    const overlappingPosts = await Promise.all([1, 2].map(() => fetch(
      `${baseUrl}/api/inventory/receipts/${firstReceiptLine.id}/post`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationId }),
      },
    )));
    const overlappingResults = await Promise.all(overlappingPosts.map(async (response) => ({
      status: response.status,
      payload: await response.json() as any,
    })));
    assert.deepEqual(overlappingResults.map((result) => result.status).sort(), [201, 409]);
    const successfulPost = overlappingResults.find((result) => result.status === 201)!;
    posted.push(successfulPost.payload.movement);
    const firstLineMovements = await db.select().from(inventoryMovements)
      .where(eq(inventoryMovements.sourceKey, `shipment-line-${firstReceiptLine.id}-to-${partialQuantities[0]}`));
    assert.equal(firstLineMovements.length, 1, "overlapping posts must create only one stock movement");
    const firstLineJournals = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "stock_receipt"),
      eq(journalEntries.sourceId, firstLineMovements[0]!.id),
    ));
    assert.equal(firstLineJournals.length, 1, "overlapping posts must create only one receipt journal");
    const firstLineJournalLines = await db.select({
      accountKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalLines.journalEntryId, firstLineJournals[0]!.id));
    assert.equal(journalLinesAreBalanced(firstLineJournalLines.map((line) => ({
      accountKey: line.accountKey ?? "",
      debitZmw: line.debitZmw,
      creditZmw: line.creditZmw,
    }))), true, "the single receipt journal must remain balanced");

    for (const line of receivedLines.slice(1)) {
      const { movement } = await request(
        "POST",
        `/api/inventory/receipts/${line.id}/post`,
        { locationId },
        201,
      );
      posted.push(movement);
    }
    assert.deepEqual(posted.map((movement) => movement.quantityDelta).sort((a, b) => a - b), [1, 2]);
    assert.deepEqual(await receiptQueue(), []);

    for (const line of receivedLines) {
      await request(
        "POST",
        `/api/inventory/receipts/${line.id}/post`,
        { locationId },
        409,
      );
    }

    const { shipment: completedShipment } = await request("PATCH", `/api/shipments/${shipmentId}/receive`, {
      lines: receivedLines.map((line) => ({
        shipmentLineId: line.id,
        quantityReceived: line.quantityShipped,
      })),
    }, 200);
    assert.equal(completedShipment.status, "received");
    assert.deepEqual(
      (await receiptQueue()).map((line: any) => [line.id, line.quantityToPost]).sort((a: number[], b: number[]) => a[0]! - b[0]!),
      receivedLines.map((line, index) => [line.id, orderSpecifications[index]!.quantity - partialQuantities[index]])
        .sort((a, b) => a[0]! - b[0]!),
    );
    const remainingMovements = [];
    for (const line of receivedLines) {
      const { movement } = await request(
        "POST",
        `/api/inventory/receipts/${line.id}/post`,
        { locationId },
        201,
      );
      remainingMovements.push(movement);
    }
    assert.deepEqual(remainingMovements.map((movement) => movement.quantityDelta).sort((a, b) => a - b), [1, 2]);
    assert.deepEqual(await receiptQueue(), []);

    for (const line of receivedLines) {
      await request(
        "POST",
        `/api/inventory/receipts/${line.id}/post`,
        { locationId },
        409,
      );
    }

    const allPosted = [...posted, ...remainingMovements];
    assert.deepEqual(
      allPosted.map((movement) => [movement.productId, movement.quantityDelta, movement.locationId]).sort(),
      productIds.flatMap((productId, index) => [
        [productId, partialQuantities[index], locationId],
        [productId, orderSpecifications[index]!.quantity - partialQuantities[index]!, locationId],
      ]).sort(),
    );

    const testMovements = await db.select().from(inventoryMovements)
      .where(and(
        inArray(inventoryMovements.productId, productIds),
        eq(inventoryMovements.kind, "stock_receipt"),
      ));
    assert.equal(testMovements.length, 4, "each receipt increment should create one stock movement");
    assert.deepEqual(
      testMovements.map((movement) => movement.quantityDelta).sort((a, b) => a - b),
      [1, 1, 2, 2],
    );
    const stockedLines = await db.select().from(shipmentLines)
      .where(eq(shipmentLines.shipmentId, shipment.id));
    assert.deepEqual(
      stockedLines.map((line) => [line.quantityReceived, line.quantityStocked]).sort((a, b) => a[0]! - b[0]!),
      [[2, 2], [4, 4]],
    );

    const receiptEntries = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "stock_receipt"),
      inArray(journalEntries.sourceId, testMovements.map((movement) => movement.id)),
    ));
    assert.equal(receiptEntries.length, 4, "each stock movement should have exactly one journal entry");

    for (const movement of testMovements) {
      const entry = receiptEntries.find((row) => row.sourceId === movement.id);
      assert.ok(entry);
      const lines = await db.select({
        accountKey: accountingAccounts.systemKey,
        debitZmw: journalLines.debitZmw,
        creditZmw: journalLines.creditZmw,
      }).from(journalLines)
        .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
        .where(eq(journalLines.journalEntryId, entry.id));
      assert.equal(journalLinesAreBalanced(lines.map((line) => ({
        accountKey: line.accountKey ?? "",
        debitZmw: line.debitZmw,
        creditZmw: line.creditZmw,
      }))), true, `journal ${entry.id} should balance`);
      const orderLine = createdOrderLines.find((row) => row.id ===
        receivedLines.find((shipmentLine) => shipmentLine.id === entry.shipmentLineId)?.purchaseOrderLineId);
      assert.ok(orderLine, `journal ${entry.id} should link to its purchase-order line`);
      const specification = orderSpecifications[productIds.indexOf(movement.productId)]!;
      const priorQuantity = stockedByOrderLine.get(orderLine.id)!;
      const allocatedFreight = allocatedExpenseByLine.get(orderLine.id)!;
      const allocatedThrough = (quantity: number) =>
        (allocatedFreight * BigInt(quantity) + BigInt(specification.quantity) / 2n)
        / BigInt(specification.quantity);
      const freightIncrement = allocatedThrough(priorQuantity + movement.quantityDelta) - allocatedThrough(priorQuantity);
      const goodsCost = cents(specification.expectedCost) * BigInt(movement.quantityDelta)
        / BigInt(specification.quantity);
      const expectedIncrementCost = formatCents(goodsCost + freightIncrement);
      assert.deepEqual(lines.map((line) => [
        line.accountKey, line.debitZmw, line.creditZmw,
      ]).sort(([left], [right]) => String(left).localeCompare(String(right))), [
        ["inventory", expectedIncrementCost, "0.00"],
        ["accounts_payable", "0.00", formatCents(goodsCost)],
        ["landed_cost_clearing", "0.00", formatCents(freightIncrement)],
      ].sort(([left], [right]) => String(left).localeCompare(String(right))));
      stockedByOrderLine.set(orderLine.id, priorQuantity + movement.quantityDelta);
    }
    const receiptClearingLines = await db.select({
      creditZmw: journalLines.creditZmw,
    }).from(journalEntries)
      .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(and(
        eq(journalEntries.sourceType, "stock_receipt"),
        inArray(journalEntries.sourceId, testMovements.map((movement) => movement.id)),
        eq(accountingAccounts.systemKey, "landed_cost_clearing"),
      ));
    assert.equal(
      receiptClearingLines.reduce((total, line) => total + cents(line.creditZmw), 0n),
      cents("120.00"),
      "receipt journals should clear the shared freight allocation exactly once",
    );
    assert.equal(
      (await db.select().from(journalEntries).where(and(
        eq(journalEntries.sourceType, "import_expense"),
        eq(journalEntries.sourceId, expense.id),
      ))).length,
      1,
      "receipt posting and retries must not duplicate the freight payable journal",
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      if (shipmentId) {
        await client.query(`
          DELETE FROM journal_lines
          WHERE journal_entry_id IN (
            SELECT id FROM journal_entries
            WHERE source_type = 'import_expense'
              AND source_id IN (SELECT id FROM import_expenses WHERE shipment_id = $1)
          )
        `, [shipmentId]);
        await client.query(`
          DELETE FROM journal_entries
          WHERE source_type = 'import_expense'
            AND source_id IN (SELECT id FROM import_expenses WHERE shipment_id = $1)
        `, [shipmentId]);
        await client.query("DELETE FROM import_expenses WHERE shipment_id = $1", [shipmentId]);
      }
      if (productIds.length) {
        await client.query(`
          DELETE FROM journal_lines
          WHERE journal_entry_id IN (
            SELECT id FROM journal_entries
            WHERE source_type = 'stock_receipt'
              AND source_id IN (
                SELECT id FROM inventory_movements WHERE product_id = ANY($1::int[])
              )
          )
        `, [productIds]);
        await client.query(`
          DELETE FROM journal_entries
          WHERE source_type = 'stock_receipt'
            AND source_id IN (
              SELECT id FROM inventory_movements WHERE product_id = ANY($1::int[])
            )
        `, [productIds]);
        await client.query("DELETE FROM inventory_movements WHERE product_id = ANY($1::int[])", [productIds]);
      }
      if (shipmentId) {
        await client.query("DELETE FROM shipment_lines WHERE shipment_id = $1", [shipmentId]);
        await client.query("DELETE FROM shipment_purchase_orders WHERE shipment_id = $1", [shipmentId]);
        await client.query("DELETE FROM shipments WHERE id = $1", [shipmentId]);
      }
      if (purchaseOrderIds.length) {
        await client.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = ANY($1::int[])", [purchaseOrderIds]);
        await client.query("DELETE FROM purchase_orders WHERE id = ANY($1::int[])", [purchaseOrderIds]);
      }
      if (productIds.length) await client.query("DELETE FROM products WHERE id = ANY($1::int[])", [productIds]);
      if (supplierIds.length) await client.query("DELETE FROM suppliers WHERE id = ANY($1::int[])", [supplierIds]);
      if (locationId) await client.query("DELETE FROM inventory_locations WHERE id = $1", [locationId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }
});
