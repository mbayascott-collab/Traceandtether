import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  accountingAccounts, businessAuditLogs, customers, importExpenses, inventoryLocations, inventoryMovements,
  journalEntries, journalLines, products, purchaseOrderLines, shipmentLines,
  salesDeliveryLines, salesOrderLines, suppliers,
} from "../shared/schema";
import { journalLinesAreBalanced } from "./accounting-posting";

test("database flow adjusts late import costs across partial receipts and sales", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [
    { db, pool },
    { registerProcurementRoutes },
    { registerInventoryRoutes },
    { registerSalesRoutes },
  ] = await Promise.all([
    import("./db"),
    import("./procurement-routes"),
    import("./inventory-routes"),
    import("./sales-routes"),
  ]);

  const suffix = randomUUID();
  const testEmail = `accounting-posting-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: testEmail, role: "owner" };
    next();
  };
  registerProcurementRoutes(app, owner);
  registerInventoryRoutes(app, owner);
  registerSalesRoutes(app, owner);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let productId: number | undefined;
  let supplierId: number | undefined;
  let customerId: number | undefined;
  let locationId: number | undefined;
  let purchaseOrderId: number | undefined;
  let shipmentId: number | undefined;
  let shipmentLineId: number | undefined;
  let mismatchPurchaseOrderId: number | undefined;
  let mismatchShipmentId: number | undefined;
  let mismatchShipmentLineId: number | undefined;
  let salesOrderId: number | undefined;
  let deliveryId: number | undefined;
  const request = async (path: string, body: unknown, expectedStatus: number) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json() as any;
    assert.equal(response.status, expectedStatus, JSON.stringify(payload));
    return payload;
  };
  const patch = async (path: string, body: unknown, expectedStatus: number) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as any;
    assert.equal(response.status, expectedStatus, JSON.stringify(payload));
    return payload;
  };

  try {
    const [supplier] = await db.insert(suppliers).values({
      name: `Accounting flow supplier ${suffix}`,
    }).returning();
    supplierId = supplier.id;
    const [product] = await db.insert(products).values({
      sku: `ACC-${suffix}`,
      name: `Accounting flow product ${suffix}`,
      status: "active",
      purchaseCurrency: "CNY",
    }).returning();
    productId = product.id;
    const [customer] = await db.insert(customers).values({
      name: `Accounting flow customer ${suffix}`,
    }).returning();
    customerId = customer.id;
    const [location] = await db.insert(inventoryLocations).values({
      name: `Accounting flow location ${suffix}`,
    }).returning();
    locationId = location.id;

    const { order } = await request("/api/purchase-orders", {
      supplierId,
      currency: "CNY",
      exchangeRateToZmw: "2",
      expectedAt: null,
      notes: null,
      lines: [{ productId, quantityOrdered: 10, unitPrice: "100.00" }],
    }, 201);
    purchaseOrderId = order.id;
    const [orderLine] = await db.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId!));
    const { shipment } = await request("/api/shipments", {
      purchaseOrderIds: [purchaseOrderId],
      shipmentReference: `ACC-SHIP-${suffix}`,
      carrier: null,
      trackingNumber: null,
      shippedAt: null,
      expectedAt: null,
      notes: null,
      lines: [{ purchaseOrderLineId: orderLine.id, quantityShipped: 10 }],
    }, 201);
    shipmentId = shipment.id;
    const [shipmentLine] = await db.select().from(shipmentLines)
      .where(eq(shipmentLines.shipmentId, shipmentId!));
    shipmentLineId = shipmentLine.id;

    const { expense: earlyExpense } = await request("/api/import-expenses", {
      purchaseOrderId,
      shipmentId: null,
      category: "Freight",
      description: `Pre-receipt freight ${suffix}`,
      amount: "100.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-10-01",
      reference: null,
      notes: null,
    }, 201);

    await patch(`/api/shipments/${shipmentId}/receive`, {
      lines: [{ shipmentLineId, quantityReceived: 4 }],
    }, 200);
    await request(`/api/inventory/receipts/${shipmentLineId}/post`, { locationId }, 201);
    const [earlyReceiptMovement] = await db.select().from(inventoryMovements)
      .where(eq(inventoryMovements.sourceKey, `shipment-line-${shipmentLineId}-to-4`));
    const [earlyReceiptEntry] = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "stock_receipt"),
      eq(journalEntries.sourceId, earlyReceiptMovement.id),
    ));
    assert.equal(earlyReceiptEntry.shipmentLineId, shipmentLineId);
    // A legacy journal without shipmentLineId can still be recognized when
    // its original shipment-line movement key is intact.
    await db.update(journalEntries).set({ shipmentLineId: null })
      .where(eq(journalEntries.id, earlyReceiptEntry.id));
    const { orders: [identifiedLegacyReceipt] } = await request(
      `/api/landed-costs?purchaseOrderId=${purchaseOrderId}`, undefined, 200,
    );
    assert.deepEqual(identifiedLegacyReceipt.adjustmentPreview.receipts.map((receipt: any) => [
      receipt.entryNumber, receipt.quantity, receipt.clearedAmountZmw,
    ]), [[earlyReceiptEntry.entryNumber, 4, "400.00"]]);
    assert.equal(identifiedLegacyReceipt.adjustmentPreview.receiptClearedTotalZmw, "400.00");
    assert.equal(identifiedLegacyReceipt.adjustmentPreview.clearingBalanceZmw, "600.00");

    // Simulate an older record whose movement key cannot be backfilled.
    await db.update(inventoryMovements).set({ sourceKey: `legacy-receipt-${suffix}` })
      .where(eq(inventoryMovements.id, earlyReceiptMovement.id));
    const { journals: unresolvedReceipts } = await request(
      "/api/inventory/unlinked-receipt-journals", undefined, 200,
    );
    const unresolvedReceipt = unresolvedReceipts.find((row: any) => row.id === earlyReceiptEntry.id);
    assert.ok(unresolvedReceipt);
    assert.equal(unresolvedReceipt.movementId, earlyReceiptMovement.id);
    assert.ok(unresolvedReceipt.candidates.some((candidate: any) => candidate.shipmentLineId === shipmentLineId));
    const { orders: [afterEarlyExpense] } = await request(
      `/api/landed-costs?purchaseOrderId=${purchaseOrderId}`, undefined, 200,
    );
    assert.equal(afterEarlyExpense.adjustmentPreview.adjustmentAvailableZmw, "400.00");
    assert.equal(afterEarlyExpense.adjustmentPreview.canPost, true);
    assert.equal(afterEarlyExpense.adjustmentPreview.unpostedClearingZmw, "600.00");
    await request(`/api/inventory/receipt-journals/${earlyReceiptEntry.id}/link`, {
      shipmentLineId,
    }, 200);
    const [relinkedReceiptEntry] = await db.select().from(journalEntries)
      .where(eq(journalEntries.id, earlyReceiptEntry.id));
    assert.equal(relinkedReceiptEntry.shipmentLineId, shipmentLineId);
    const receiptLinkAudits = await db.select().from(businessAuditLogs).where(and(
      eq(businessAuditLogs.entityType, "journal_entry"),
      eq(businessAuditLogs.entityId, earlyReceiptEntry.id),
      eq(businessAuditLogs.actorEmail, testEmail),
      eq(businessAuditLogs.action, "updated"),
    ));
    assert.ok(receiptLinkAudits.some((audit) => audit.changedFields.includes("shipmentLineId")));
    const { orders: [afterReceiptLink] } = await request(
      `/api/landed-costs?purchaseOrderId=${purchaseOrderId}`, undefined, 200,
    );
    assert.equal(afterReceiptLink.adjustmentPreview.adjustmentAvailableZmw, "0.00");
    assert.equal(afterReceiptLink.adjustmentPreview.canPost, false);
    assert.equal(afterReceiptLink.adjustmentPreview.unpostedClearingZmw, "600.00");
    assert.deepEqual(afterReceiptLink.adjustmentPreview.receipts.map((receipt: any) => receipt.clearedAmountZmw), ["400.00"]);
    assert.equal(afterReceiptLink.adjustmentPreview.receiptClearedTotalZmw, "400.00");

    const { order: salesOrder } = await request("/api/sales-orders", {
      customerId,
      deliveryAddress: null,
      notes: null,
      lines: [{ productId, quantity: 2, unitPriceZmw: "500.00" }],
    }, 201);
    salesOrderId = salesOrder.id;
    await request(`/api/sales-orders/${salesOrderId}/confirm`, {}, 200);
    const [salesLine] = await db.select().from(salesOrderLines)
      .where(eq(salesOrderLines.salesOrderId, salesOrderId!));
    const { delivery } = await request(`/api/sales-orders/${salesOrderId}/deliveries`, {
      idempotencyKey: randomUUID(),
      deliveryDate: "2026-11-18",
      lines: [{ salesOrderLineId: salesLine.id, quantity: 2 }],
    }, 201);
    deliveryId = delivery.id;

    const { expense: lateExpense } = await request("/api/import-expenses", {
      purchaseOrderId,
      shipmentId: null,
      category: "Freight",
      description: `Late freight ${suffix}`,
      amount: "50.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-11-18",
      reference: null,
      notes: null,
    }, 201);

    const { orders: [beforeAdjustment] } = await request(
      `/api/landed-costs?purchaseOrderId=${purchaseOrderId}`, undefined, 200,
    );
    const preview = beforeAdjustment.adjustmentPreview;
    assert.equal(preview.clearingBalanceZmw, "1100.00");
    assert.equal(preview.adjustmentAvailableZmw, "200.00");
    assert.equal(preview.unpostedClearingZmw, "900.00");
    assert.equal(preview.canPost, true);
    assert.deepEqual(preview.lines.map((line: any) => [
      line.stockedQuantity, line.onHand, line.adjustmentZmw, line.inventoryZmw, line.cogsZmw,
    ]), [[4, 2, "200.00", "100.00", "100.00"]]);

    const adjustmentRequest = {
      reviewedAmountZmw: preview.adjustmentAvailableZmw,
      reviewedLines: preview.lines.map((line: any) => ({
        lineId: line.lineId,
        adjustmentZmw: line.adjustmentZmw,
        inventoryZmw: line.inventoryZmw,
        cogsZmw: line.cogsZmw,
      })),
      note: "Reviewed after partial receipts and sale",
    };
    const concurrentAdjustments = await Promise.all([
      fetch(`${baseUrl}/api/landed-costs/${purchaseOrderId}/adjust`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(adjustmentRequest),
      }),
      fetch(`${baseUrl}/api/landed-costs/${purchaseOrderId}/adjust`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(adjustmentRequest),
      }),
    ]);
    const concurrentPayloads = await Promise.all(concurrentAdjustments.map((response) => response.json() as Promise<any>));
    assert.deepEqual(concurrentAdjustments.map((response) => response.status).sort(), [201, 409]);
    const postedAdjustment = concurrentPayloads.find((payload) => payload.journalEntry)?.journalEntry;
    assert.ok(postedAdjustment, JSON.stringify(concurrentPayloads));

    await request(`/api/landed-costs/${purchaseOrderId}/adjust`, adjustmentRequest, 409);
    const [adjustmentEntry] = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "landed_cost_adjustment"),
      eq(journalEntries.sourceId, purchaseOrderId!),
    ));
    assert.ok(adjustmentEntry);
    assert.equal(adjustmentEntry.id, postedAdjustment.id);

    const adjustmentLines = await db.select({
      systemKey: accountingAccounts.systemKey,
      productId: journalLines.productId,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalLines.journalEntryId, adjustmentEntry.id));
    assert.deepEqual(adjustmentLines.map((line) => [
      line.systemKey, line.debitZmw, line.creditZmw,
    ]), [
      ["inventory", "100.00", "0.00"],
      ["cost_of_goods_sold", "100.00", "0.00"],
      ["landed_cost_clearing", "0.00", "200.00"],
    ]);
    assert.equal(adjustmentEntry.sourceId, purchaseOrderId);

    const { expense: subsequentExpense } = await request("/api/import-expenses", {
      purchaseOrderId,
      shipmentId: null,
      category: "Freight",
      description: `Later freight ${suffix}`,
      amount: "25.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-11-19",
      reference: null,
      notes: null,
    }, 201);

    await patch(`/api/shipments/${shipmentId}/receive`, {
      lines: [{ shipmentLineId, quantityReceived: 7 }],
    }, 200);
    await request(`/api/inventory/receipts/${shipmentLineId}/post`, { locationId }, 201);
    const [laterPartialReceipt] = await db.select().from(inventoryMovements)
      .where(eq(inventoryMovements.sourceKey, `shipment-line-${shipmentLineId}-to-7`));
    await db.update(inventoryMovements).set({ sourceKey: `receipt-key-reformatted-again-${suffix}` })
      .where(eq(inventoryMovements.id, laterPartialReceipt.id));

    const { orders: [afterLaterPartialReceipt] } = await request(
      `/api/landed-costs?purchaseOrderId=${purchaseOrderId}`, undefined, 200,
    );
    const incrementalPreview = afterLaterPartialReceipt.adjustmentPreview;
    assert.equal(incrementalPreview.clearingBalanceZmw, "625.00");
    assert.equal(incrementalPreview.adjustmentAvailableZmw, "100.00");
    assert.equal(incrementalPreview.unpostedClearingZmw, "525.00");
    assert.deepEqual(incrementalPreview.receipts.map((receipt: any) => receipt.clearedAmountZmw), ["400.00", "525.00"]);
    assert.equal(incrementalPreview.receiptClearedTotalZmw, "925.00");
    assert.equal(incrementalPreview.allocatedExpensesZmw, "1750.00");
    assert.equal(incrementalPreview.priorAdjustmentsClearedZmw, "200.00");
    assert.equal(
      Number(incrementalPreview.allocatedExpensesZmw)
        - Number(incrementalPreview.receiptClearedTotalZmw)
        - Number(incrementalPreview.priorAdjustmentsClearedZmw),
      Number(incrementalPreview.clearingBalanceZmw),
    );
    assert.equal(incrementalPreview.canPost, true);
    assert.deepEqual(incrementalPreview.lines.map((line: any) => [
      line.stockedQuantity, line.onHand, line.adjustmentZmw, line.inventoryZmw, line.cogsZmw,
    ]), [[7, 5, "100.00", "71.43", "28.57"]]);

    const incrementalAdjustmentRequest = {
      reviewedAmountZmw: incrementalPreview.adjustmentAvailableZmw,
      reviewedLines: incrementalPreview.lines.map((line: any) => ({
        lineId: line.lineId,
        adjustmentZmw: line.adjustmentZmw,
        inventoryZmw: line.inventoryZmw,
        cogsZmw: line.cogsZmw,
      })),
      note: "Reviewed the additional freight bill",
    };
    const { journalEntry: incrementalAdjustment } = await request(
      `/api/landed-costs/${purchaseOrderId}/adjust`, incrementalAdjustmentRequest, 201,
    );
    assert.equal(incrementalAdjustment.sourceId, purchaseOrderId);
    const incrementalAdjustmentLines = await db.select({
      systemKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalLines.journalEntryId, incrementalAdjustment.id));
    assert.deepEqual(incrementalAdjustmentLines.map((line) => [
      line.systemKey, line.debitZmw, line.creditZmw,
    ]), [
      ["inventory", "71.43", "0.00"],
      ["cost_of_goods_sold", "28.57", "0.00"],
      ["landed_cost_clearing", "0.00", "100.00"],
    ]);

    await patch(`/api/shipments/${shipmentId}/receive`, {
      lines: [{ shipmentLineId, quantityReceived: 10 }],
    }, 200);
    await request(`/api/inventory/receipts/${shipmentLineId}/post`, { locationId }, 201);
    const [secondReceiptMovement] = await db.select().from(inventoryMovements)
      .where(eq(inventoryMovements.sourceKey, `shipment-line-${shipmentLineId}-to-10`));
    await db.update(inventoryMovements).set({ sourceKey: `receipt-key-reformatted-${suffix}` })
      .where(eq(inventoryMovements.id, secondReceiptMovement.id));
    const { orders: [afterSecondReceipt] } = await request(
      `/api/landed-costs?purchaseOrderId=${purchaseOrderId}`, undefined, 200,
    );
    assert.equal(afterSecondReceipt.adjustmentPreview.clearingBalanceZmw, "0.00");
    assert.equal(afterSecondReceipt.adjustmentPreview.adjustmentAvailableZmw, "0.00");
    assert.equal(afterSecondReceipt.adjustmentPreview.unpostedClearingZmw, "0.00");
    assert.deepEqual(afterSecondReceipt.adjustmentPreview.receipts.map((receipt: any) => receipt.clearedAmountZmw), [
      "400.00", "525.00", "525.00",
    ]);
    assert.equal(afterSecondReceipt.adjustmentPreview.receiptClearedTotalZmw, "1450.00");
    assert.equal(afterSecondReceipt.adjustmentPreview.priorAdjustmentsClearedZmw, "300.00");

    const [expenseEntries, receiptMovements, adjustmentEntries, deliveryEntries] = await Promise.all([
      db.select().from(journalEntries).where(and(
        eq(journalEntries.sourceType, "import_expense"),
      inArray(journalEntries.sourceId, [earlyExpense.id, lateExpense.id, subsequentExpense.id]),
      )),
      db.select().from(inventoryMovements).where(and(
        eq(inventoryMovements.productId, productId!),
        eq(inventoryMovements.kind, "stock_receipt"),
      )),
      db.select().from(journalEntries).where(and(
        eq(journalEntries.sourceType, "landed_cost_adjustment"),
        eq(journalEntries.sourceId, purchaseOrderId!),
      )),
      db.select().from(journalEntries).where(and(
        inArray(journalEntries.sourceType, ["sales_delivery", "sales_delivery_cogs"]),
        eq(journalEntries.sourceId, deliveryId!),
      )),
    ]);
    assert.equal(expenseEntries.length, 3);
    assert.equal(receiptMovements.length, 3);
    assert.equal(adjustmentEntries.length, 2);
    assert.equal(deliveryEntries.length, 2);

    const [salesCogsEntry] = deliveryEntries.filter((entry) => entry.sourceType === "sales_delivery_cogs");
    assert.ok(salesCogsEntry);
    const salesCogsLines = await db.select({
      systemKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalLines.journalEntryId, salesCogsEntry.id));
    assert.deepEqual(salesCogsLines.map((line) => [
      line.systemKey, line.debitZmw, line.creditZmw,
    ]), [
      ["cost_of_goods_sold", "600.00", "0.00"],
      ["inventory", "0.00", "600.00"],
    ]);

    const receiptEntries = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "stock_receipt"),
      inArray(journalEntries.sourceId, receiptMovements.map((movement) => movement.id)),
    ));
    const allTestEntries = [...expenseEntries, ...receiptEntries, ...adjustmentEntries, ...deliveryEntries];
    assert.equal(receiptEntries.length, 3);
    for (const entry of allTestEntries) {
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
      }))), true, `Journal ${entry.id} is unbalanced`);
    }

    const [linkedExpenses, linkedReceiptLines] = await Promise.all([
      db.select().from(importExpenses).where(eq(importExpenses.purchaseOrderId, purchaseOrderId!)),
      db.select({ id: shipmentLines.id, orderId: purchaseOrderLines.purchaseOrderId })
        .from(shipmentLines)
        .innerJoin(purchaseOrderLines, eq(shipmentLines.purchaseOrderLineId, purchaseOrderLines.id))
        .where(eq(shipmentLines.shipmentId, shipmentId!)),
    ]);
    assert.equal(linkedExpenses.length, 3);
    assert.deepEqual(linkedExpenses.map((expense) => expense.id).sort(), [
      earlyExpense.id, lateExpense.id, subsequentExpense.id,
    ].sort());
    assert.equal(linkedReceiptLines.length, 1);
    assert.deepEqual(receiptMovements.map((movement) => movement.quantityDelta).sort(), [3, 3, 4]);
    assert.ok(linkedReceiptLines.every((line) => line.orderId === purchaseOrderId));
    assert.ok(receiptEntries.every((entry) => receiptMovements.some((movement) => movement.id === entry.sourceId)));
    assert.deepEqual(receiptEntries.map((entry) => entry.shipmentLineId).sort(), [
      shipmentLineId, shipmentLineId, shipmentLineId,
    ].sort());

    const [deliveryLine] = await db.select().from(salesDeliveryLines)
      .where(eq(salesDeliveryLines.deliveryId, deliveryId!));
    const returnRequest = {
      idempotencyKey: randomUUID(),
      locationId,
      quantity: 1,
      returnDate: "2026-11-18",
      reason: "Customer returned one unused unit",
    };
    const { movement: returnMovement } = await request(
      `/api/sales-delivery-lines/${deliveryLine.id}/returns`, returnRequest, 201,
    );
    assert.equal(returnMovement.salesDeliveryLineId, deliveryLine.id);
    assert.equal(returnMovement.quantityDelta, 1);
    assert.equal(returnMovement.locationId, locationId);
    const duplicateReturn = await request(
      `/api/sales-delivery-lines/${deliveryLine.id}/returns`, returnRequest, 200,
    );
    assert.equal(duplicateReturn.movement.id, returnMovement.id);
    await request(`/api/sales-delivery-lines/${deliveryLine.id}/returns`, {
      ...returnRequest, idempotencyKey: randomUUID(), quantity: 2,
    }, 409);
    const { orders: [returnedOrder] } = await request("/api/sales-orders", undefined, 200);
    const returnedLine = returnedOrder.deliveries
      .find((item: any) => item.id === deliveryId)?.lines
      .find((item: any) => item.salesDeliveryLineId === deliveryLine.id);
    assert.equal(returnedLine.returnedQuantity, 1);
    assert.equal(returnedLine.returns[0].quantity, 1);
    const returnEntries = await db.select().from(journalEntries).where(and(
      inArray(journalEntries.sourceType, ["sales_return", "sales_return_cogs"]),
      eq(journalEntries.sourceId, returnMovement.id),
    ));
    assert.equal(returnEntries.length, 2);
    for (const entry of returnEntries) {
      const lines = await db.select({
        debitZmw: journalLines.debitZmw, creditZmw: journalLines.creditZmw,
      }).from(journalLines).where(eq(journalLines.journalEntryId, entry.id));
      assert.equal(journalLinesAreBalanced(lines.map((line) => ({ ...line, accountKey: "return-test" }))), true);
    }

    const { order: mismatchOrder } = await request("/api/purchase-orders", {
      supplierId,
      currency: "CNY",
      exchangeRateToZmw: "2",
      expectedAt: null,
      notes: null,
      lines: [{ productId, quantityOrdered: 10, unitPrice: "100.00" }],
    }, 201);
    mismatchPurchaseOrderId = mismatchOrder.id;
    const [mismatchOrderLine] = await db.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, mismatchPurchaseOrderId!));
    const { shipment: mismatchShipment } = await request("/api/shipments", {
      purchaseOrderIds: [mismatchPurchaseOrderId],
      shipmentReference: `ACC-MISMATCH-SHIP-${suffix}`,
      carrier: null,
      trackingNumber: null,
      shippedAt: null,
      expectedAt: null,
      notes: null,
      lines: [{ purchaseOrderLineId: mismatchOrderLine.id, quantityShipped: 10 }],
    }, 201);
    mismatchShipmentId = mismatchShipment.id;
    const [mismatchShipmentLine] = await db.select().from(shipmentLines)
      .where(eq(shipmentLines.shipmentId, mismatchShipmentId!));
    mismatchShipmentLineId = mismatchShipmentLine.id;
    await request("/api/import-expenses", {
      purchaseOrderId: mismatchPurchaseOrderId,
      shipmentId: null,
      category: "Freight",
      description: `Receipt clearing mismatch ${suffix}`,
      amount: "100.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-11-19",
      reference: null,
      notes: null,
    }, 201);
    await patch(`/api/shipments/${mismatchShipmentId}/receive`, {
      lines: [{ shipmentLineId: mismatchShipmentLineId, quantityReceived: 4 }],
    }, 200);
    await request(`/api/inventory/receipts/${mismatchShipmentLineId}/post`, { locationId }, 201);
    const [mismatchMovement] = await db.select().from(inventoryMovements)
      .where(eq(inventoryMovements.sourceKey, `shipment-line-${mismatchShipmentLineId}-to-4`));
    const [mismatchReceiptEntry] = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "stock_receipt"),
      eq(journalEntries.sourceId, mismatchMovement.id),
    ));
    await db.update(journalEntries).set({ shipmentLineId: null })
      .where(eq(journalEntries.id, mismatchReceiptEntry.id));
    const overCapacityLink = await fetch(`${baseUrl}/api/inventory/receipt-journals/${mismatchReceiptEntry.id}/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shipmentLineId }),
    });
    assert.equal(overCapacityLink.status, 409);
    await request(`/api/inventory/receipt-journals/${mismatchReceiptEntry.id}/link`, {
      shipmentLineId: mismatchShipmentLineId,
    }, 200);
    const [clearingAccount] = await db.select().from(accountingAccounts)
      .where(eq(accountingAccounts.systemKey, "landed_cost_clearing"));
    const [receiptClearingLine] = await db.select().from(journalLines).where(and(
      eq(journalLines.journalEntryId, mismatchReceiptEntry.id),
      eq(journalLines.accountId, clearingAccount.id),
    ));
    // The receipt should clear 400.00 ZMW; corrupt it by one ZMW to simulate
    // a product-level difference in the posted receipt history.
    await db.update(journalLines).set({ creditZmw: "401.00" })
      .where(eq(journalLines.id, receiptClearingLine.id));

    const { orders: [mismatchPreviewOrder] } = await request(
      `/api/landed-costs?purchaseOrderId=${mismatchPurchaseOrderId}`, undefined, 200,
    );
    const mismatchPreview = mismatchPreviewOrder.adjustmentPreview;
    assert.equal(mismatchPreview.hasNegativeLine, true);
    assert.equal(mismatchPreview.canPost, false);
    assert.equal(mismatchPreview.adjustmentAvailableZmw, "0.00");
    assert.deepEqual(mismatchPreview.lines.map((line: any) => [
      line.stockedQuantity, line.adjustmentZmw,
    ]), [[4, "-1.00"]]);

    const mismatchAdjustmentRequest = {
      reviewedAmountZmw: mismatchPreview.adjustmentAvailableZmw,
      reviewedLines: mismatchPreview.lines.map((line: any) => ({
        lineId: line.lineId,
        adjustmentZmw: "0.00",
        inventoryZmw: "0.00",
        cogsZmw: "0.00",
      })),
      note: "Review receipt clearing mismatch",
    };
    const [adjustmentsBeforeMismatchRequest] = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "landed_cost_adjustment"),
      eq(journalEntries.sourceId, mismatchPurchaseOrderId!),
    ));
    assert.equal(adjustmentsBeforeMismatchRequest, undefined);
    const mismatchResponse = await fetch(`${baseUrl}/api/landed-costs/${mismatchPurchaseOrderId}/adjust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mismatchAdjustmentRequest),
    });
    const mismatchPayload = await mismatchResponse.json() as any;
    assert.equal(mismatchResponse.status, 409, JSON.stringify(mismatchPayload));
    assert.match(mismatchPayload.error, /product-level clearing difference/i);
    const adjustmentsAfterMismatchRequest = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "landed_cost_adjustment"),
      eq(journalEntries.sourceId, mismatchPurchaseOrderId!),
    ));
    assert.equal(adjustmentsAfterMismatchRequest.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const auditTable = await client.query(
        "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
      );
      if (auditTable.rows[0]?.exists) {
        await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [testEmail]);
      }
      if (productId) {
        await client.query(`
          DELETE FROM journal_lines
          WHERE journal_entry_id IN (
            SELECT id FROM journal_entries
            WHERE (source_type = 'import_expense' AND source_id IN (
              SELECT id FROM import_expenses WHERE purchase_order_id IN ($1, $4)
            ))
            OR (source_type = 'stock_receipt' AND source_id IN (
              SELECT id FROM inventory_movements WHERE product_id = $2
            ))
            OR (source_type = 'landed_cost_adjustment' AND source_id IN ($1, $4))
            OR (source_type IN ('sales_delivery', 'sales_delivery_cogs') AND source_id IN (
              SELECT id FROM sales_deliveries WHERE sales_order_id = $3
            ))
            OR (source_type IN ('sales_return', 'sales_return_cogs') AND source_id IN (
              SELECT id FROM inventory_movements WHERE sales_delivery_line_id IN (
                SELECT id FROM sales_delivery_lines WHERE delivery_id IN (
                  SELECT id FROM sales_deliveries WHERE sales_order_id = $3
                )
              )
            ))
          )
        `, [purchaseOrderId ?? 0, productId, salesOrderId ?? 0, mismatchPurchaseOrderId ?? 0]);
        await client.query(`
          DELETE FROM journal_entries
          WHERE (source_type = 'import_expense' AND source_id IN (
            SELECT id FROM import_expenses WHERE purchase_order_id IN ($1, $4)
          ))
          OR (source_type = 'stock_receipt' AND source_id IN (
            SELECT id FROM inventory_movements WHERE product_id = $2
          ))
          OR (source_type = 'landed_cost_adjustment' AND source_id IN ($1, $4))
          OR (source_type IN ('sales_delivery', 'sales_delivery_cogs') AND source_id IN (
            SELECT id FROM sales_deliveries WHERE sales_order_id = $3
          ))
          OR (source_type IN ('sales_return', 'sales_return_cogs') AND source_id IN (
            SELECT id FROM inventory_movements WHERE sales_delivery_line_id IN (
              SELECT id FROM sales_delivery_lines WHERE delivery_id IN (
                SELECT id FROM sales_deliveries WHERE sales_order_id = $3
              )
            )
          ))
        `, [purchaseOrderId ?? 0, productId, salesOrderId ?? 0, mismatchPurchaseOrderId ?? 0]);
        await client.query("DELETE FROM inventory_movements WHERE product_id = $1", [productId]);
      }
      if (deliveryId) await client.query(
        "DELETE FROM sales_delivery_lines WHERE delivery_id = $1", [deliveryId],
      );
      if (deliveryId) await client.query("DELETE FROM sales_deliveries WHERE id = $1", [deliveryId]);
      if (salesOrderId) {
        await client.query("DELETE FROM inventory_reservations WHERE sales_order_id = $1", [salesOrderId]);
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [salesOrderId]);
        await client.query("DELETE FROM sales_orders WHERE id = $1", [salesOrderId]);
      }
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
      if (purchaseOrderId) {
        await client.query("DELETE FROM import_expenses WHERE purchase_order_id = $1", [purchaseOrderId]);
        if (shipmentId) {
          await client.query("DELETE FROM shipment_lines WHERE shipment_id = $1", [shipmentId]);
          await client.query("DELETE FROM shipment_purchase_orders WHERE shipment_id = $1", [shipmentId]);
          await client.query("DELETE FROM shipments WHERE id = $1", [shipmentId]);
        }
        await client.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1", [purchaseOrderId]);
        await client.query("DELETE FROM purchase_orders WHERE id = $1", [purchaseOrderId]);
      }
      if (mismatchPurchaseOrderId) {
        await client.query("DELETE FROM import_expenses WHERE purchase_order_id = $1", [mismatchPurchaseOrderId]);
        if (mismatchShipmentId) {
          await client.query("DELETE FROM shipment_lines WHERE shipment_id = $1", [mismatchShipmentId]);
          await client.query("DELETE FROM shipment_purchase_orders WHERE shipment_id = $1", [mismatchShipmentId]);
          await client.query("DELETE FROM shipments WHERE id = $1", [mismatchShipmentId]);
        }
        await client.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1", [mismatchPurchaseOrderId]);
        await client.query("DELETE FROM purchase_orders WHERE id = $1", [mismatchPurchaseOrderId]);
      }
      if (productId) await client.query("DELETE FROM products WHERE id = $1", [productId]);
      if (supplierId) await client.query("DELETE FROM suppliers WHERE id = $1", [supplierId]);
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
