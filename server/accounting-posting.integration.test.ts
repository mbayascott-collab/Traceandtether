import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test, { after } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  accountingAccounts, businessAuditLogs, businessPayments, customers, importExpenses, inventoryLocations, inventoryMovements,
  journalEntries, journalLines, paymentReminders, products, purchaseOrderLines, salesOrders, shipmentLines,
  salesDeliveryLines, salesOrderLines, suppliers,
} from "../shared/schema";
import { journalLinesAreBalanced } from "./accounting-posting";

let closeIntegrationPool: (() => Promise<void>) | undefined;
after(async () => closeIntegrationPool?.());

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
  closeIntegrationPool = () => pool.end();

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
    }
  }
});

test("customer receipts wait for an in-flight reminder send to finish", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [
    { db, pool },
    { registerPaymentRoutes },
    { buildPaymentReminderEmail },
  ] = await Promise.all([
    import("./db"),
    import("./payment-routes"),
    import("./payment-reminder-email"),
  ]);
  closeIntegrationPool = () => pool.end();

  const requiredTables = await pool.query<{ name: string; exists: boolean }>(`
    SELECT name, to_regclass('public.' || name) IS NOT NULL AS exists
    FROM unnest(ARRAY['business_audit_logs', 'payment_reminders']) AS name
  `);
  if (requiredTables.rows.some((row) => !row.exists)) {
    t.skip("requires the business audit and payment reminder migrations");
    return;
  }

  const suffix = randomUUID();
  const actorId = `payment-reminder-race-${suffix}`;
  const actorEmail = `${actorId}@example.test`;
  const app = express();
  app.use(express.json());

  let senderEntered!: () => void;
  const senderEnteredPromise = new Promise<void>((resolve) => { senderEntered = resolve; });
  let releaseSender!: () => void;
  const senderPause = new Promise<void>((resolve) => { releaseSender = resolve; });
  let receiptRequestSeen!: () => void;
  const receiptRequestSeenPromise = new Promise<void>((resolve) => { receiptRequestSeen = resolve; });
  let sentContent: import("./payment-reminder-email").PaymentReminderEmailContent | undefined;
  let receiptRequests = 0;

  app.use((req, _res, next) => {
    if (req.method === "POST" && req.path === "/api/payments") {
      receiptRequests += 1;
      receiptRequestSeen();
    }
    next();
  });
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: actorId, email: actorEmail, role: "owner" };
    next();
  };
  registerPaymentRoutes(app, owner, async (content) => {
    sentContent = content;
    senderEntered();
    await senderPause;
    return { ok: true, messageId: `gmail-test-${suffix}` };
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let customerId: number | undefined;
  let productId: number | undefined;
  let salesOrderId: number | undefined;
  let reminderRequest: Promise<Response> | undefined;
  let receiptRequest: Promise<Response> | undefined;

  try {
    const [customer] = await db.insert(customers).values({
      name: `Payment reminder race customer ${suffix}`,
      email: `reminder-${suffix}@example.test`,
    }).returning();
    customerId = customer.id;
    const [product] = await db.insert(products).values({
      sku: `REM-${suffix}`,
      name: `Payment reminder race product ${suffix}`,
      status: "active",
    }).returning();
    productId = product.id;
    const [order] = await db.insert(salesOrders).values({
      orderNumber: `REM-${suffix.slice(0, 12)}`,
      customerId,
      status: "fulfilled",
      orderDate: "2020-01-01",
      dueDate: "2020-01-01",
    }).returning();
    salesOrderId = order.id;
    await db.insert(salesOrderLines).values({
      salesOrderId,
      productId,
      quantity: 2,
      unitPriceZmw: "100.00",
    });

    reminderRequest = fetch(`${baseUrl}/api/payments/${salesOrderId}/reminder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "" }),
    });
    await senderEnteredPromise;
    assert.equal(sentContent?.outstandingZmw, "200.00");

    receiptRequest = fetch(`${baseUrl}/api/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        direction: "customer_receipt",
        idempotencyKey: randomUUID(),
        orderId: salesOrderId,
        amountZmw: "75.00",
        paymentDate: "2026-11-19",
        method: "bank_transfer",
        reference: `receipt-${suffix}`,
        notes: null,
      }),
    });
    await receiptRequestSeenPromise;

    const receiptBeforeSendFinished = await Promise.race([
      receiptRequest.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(receiptBeforeSendFinished, false, "the receipt must wait while the reminder is being sent");
    assert.equal(receiptRequests, 1);
    assert.equal((await db.select().from(businessPayments).where(eq(businessPayments.salesOrderId, salesOrderId))).length, 0);

    releaseSender();
    const [reminderResponse, receiptResponse] = await Promise.all([reminderRequest, receiptRequest]);
    const reminderPayload = await reminderResponse.json() as any;
    const receiptPayload = await receiptResponse.json() as any;
    assert.equal(reminderResponse.status, 200, JSON.stringify(reminderPayload));
    assert.equal(receiptResponse.status, 201, JSON.stringify(receiptPayload));
    assert.equal(reminderPayload.reminder.outstandingZmw, "200.00");
    assert.equal(reminderPayload.reminder.status, "sent");
    assert.equal(receiptPayload.payment.amountZmw, "75.00");

    assert.ok(sentContent);
    const raw = Buffer.from(buildPaymentReminderEmail(sentContent), "base64url").toString("utf8");
    const encodedBody = raw.slice(raw.indexOf("\r\n\r\n") + 4).replace(/\r\n/g, "");
    const emailBody = Buffer.from(encodedBody, "base64").toString("utf8");
    assert.match(emailBody, /Amount still owed: ZMW 200\.00/);
    const [savedReminder] = await db.select().from(paymentReminders)
      .where(eq(paymentReminders.id, reminderPayload.reminder.id));
    assert.equal(savedReminder.status, "sent");
    assert.ok(savedReminder.sentAt);

    const [failedReminder] = await db.insert(paymentReminders).values({
      salesOrderId,
      recipientEmail: `failed-${suffix}@example.test`,
      outstandingZmw: "175.00",
      dueDate: "2020-01-01",
      status: "failed",
      sendError: "Mailbox unavailable",
    }).returning();
    const overviewResponse = await fetch(`${baseUrl}/api/payments`);
    const overview = await overviewResponse.json() as any;
    assert.equal(overviewResponse.status, 200, JSON.stringify(overview));
    const invoice = overview.invoices.find((item: any) => item.orderId === salesOrderId);
    assert.ok(invoice, "the unpaid order remains in the outstanding-balance list");
    assert.deepEqual(invoice.reminderHistory.map((reminder: any) => reminder.id), [failedReminder.id, savedReminder.id]);
    assert.deepEqual(invoice.reminderHistory.map((reminder: any) => reminder.status), ["failed", "sent"]);
    assert.equal(invoice.reminderHistory[0].recipientEmail, failedReminder.recipientEmail);
    assert.equal(invoice.reminderHistory[0].outstandingZmw, "175.00");
    assert.equal(invoice.reminderHistory[0].error, "Mailbox unavailable");
    assert.equal(invoice.reminderHistory[1].outstandingZmw, "200.00");
    assert.equal(overview.payments.filter((payment: any) => payment.orderNumber === order.orderNumber).length, 1,
      "viewing reminder history does not create or alter payment records");
  } finally {
    releaseSender();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (salesOrderId) {
        await client.query("DELETE FROM payment_reminders WHERE sales_order_id = $1", [salesOrderId]);
        await client.query(
          `DELETE FROM journal_lines WHERE journal_entry_id IN (
             SELECT id FROM journal_entries WHERE source_type = 'payment' AND source_id IN (
               SELECT id FROM business_payments WHERE sales_order_id = $1
             )
           )`,
          [salesOrderId],
        );
        await client.query(
          `DELETE FROM journal_entries WHERE source_type = 'payment' AND source_id IN (
             SELECT id FROM business_payments WHERE sales_order_id = $1
           )`,
          [salesOrderId],
        );
        await client.query("DELETE FROM business_payments WHERE sales_order_id = $1", [salesOrderId]);
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [salesOrderId]);
        await client.query("DELETE FROM sales_orders WHERE id = $1", [salesOrderId]);
      }
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      if (productId) await client.query("DELETE FROM products WHERE id = $1", [productId]);
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});

test("simultaneous shipment bill saves and retries do not create duplicate expenses or payable journals", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerProcurementRoutes }] = await Promise.all([
    import("./db"),
    import("./procurement-routes"),
  ]);
  if (!closeIntegrationPool) closeIntegrationPool = () => pool.end();
  const auditTable = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
  );
  if (!auditTable.rows[0]?.exists) {
    t.skip("requires the business audit migration used by shipment routes");
    return;
  }

  const suffix = randomUUID();
  const actorEmail = `forwarder-bill-retry-${suffix}@example.test`;
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

  let productId: number | undefined;
  let supplierId: number | undefined;
  let purchaseOrderId: number | undefined;
  let shipmentId: number | undefined;
  const request = async (body: unknown, expectedStatus: number) => {
    const response = await fetch(`${baseUrl}/api/import-expenses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as any;
    assert.equal(response.status, expectedStatus, JSON.stringify(payload));
    return payload;
  };
  const simultaneousRequest = async (body: unknown) => {
    const response = await fetch(`${baseUrl}/api/import-expenses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() as any };
  };

  try {
    const [supplier] = await db.insert(suppliers).values({
      name: `Forwarder bill retry supplier ${suffix}`,
    }).returning();
    supplierId = supplier.id;
    const [product] = await db.insert(products).values({
      sku: `FBR-${suffix}`,
      name: `Forwarder bill retry product ${suffix}`,
      status: "active",
      purchaseCurrency: "CNY",
    }).returning();
    productId = product.id;
    const { order } = await requestToRoute(baseUrl, "/api/purchase-orders", {
      supplierId: supplier.id,
      currency: "CNY",
      exchangeRateToZmw: "2",
      expectedAt: null,
      notes: null,
      lines: [{ productId: product.id, quantityOrdered: 5, unitPrice: "100.00" }],
    }, 201);
    purchaseOrderId = order.id;
    const [orderLine] = await db.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, order.id));
    const { shipment } = await requestToRoute(baseUrl, "/api/shipments", {
      purchaseOrderIds: [order.id],
      shipmentReference: `FBR-SHIP-${suffix}`,
      carrier: null,
      trackingNumber: null,
      shippedAt: null,
      expectedAt: null,
      notes: null,
      lines: [{ purchaseOrderLineId: orderLine.id, quantityShipped: 5 }],
    }, 201);
    shipmentId = shipment.id;

    const referencedBill = {
      purchaseOrderId: null,
      shipmentId,
      category: "Freight",
      description: `Forwarder bill ${suffix}`,
      amount: "20.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-11-19",
      reference: `FW-${suffix}`,
      notes: null,
    };
    const { expense: referencedExpense } = await request(referencedBill, 201);
    const duplicateReferenced = await request(referencedBill, 409);
    assert.match(duplicateReferenced.error, /already recorded for this shipment/i);

    const blankReferenceBill = {
      ...referencedBill,
      description: `Unreferenced forwarder bill ${suffix}`,
      amount: "30.00",
      reference: null,
    };
    const { expense: blankReferenceExpense } = await request(blankReferenceBill, 201);
    const duplicateBlankReference = await request(blankReferenceBill, 409);
    assert.match(duplicateBlankReference.error, /already recorded for this shipment/i);

    const concurrentBill = {
      ...referencedBill,
      description: `Concurrent forwarder bill ${suffix}`,
      amount: "35.00",
      reference: `FW-CONCURRENT-${suffix}`,
    };
    const concurrentResults = await Promise.all([
      simultaneousRequest(concurrentBill),
      simultaneousRequest(concurrentBill),
    ]);
    assert.deepEqual(concurrentResults.map((result) => result.status).sort(), [201, 409],
      "exactly one simultaneous save should create the bill");
    const winningResult = concurrentResults.find((result) => result.status === 201)!;
    const losingResult = concurrentResults.find((result) => result.status === 409)!;
    assert.ok(winningResult.payload.expense?.id, "the winning save should return its recorded expense");
    assert.match(losingResult.payload.error, /already recorded for this shipment/i,
      "the losing save should receive the already-recorded response");
    const concurrentExpenses = await db.select().from(importExpenses).where(and(
      eq(importExpenses.shipmentId, shipmentId!),
      eq(importExpenses.description, concurrentBill.description),
    ));
    assert.equal(concurrentExpenses.length, 1, "simultaneous saves should leave one recorded expense");
    assert.equal(concurrentExpenses[0]!.id, winningResult.payload.expense.id);
    const concurrentEntries = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "import_expense"),
      eq(journalEntries.sourceId, concurrentExpenses[0]!.id),
    ));
    assert.equal(concurrentEntries.length, 1, "the concurrent bill should post one payable journal entry");
    const concurrentPayableLines = await db.select({ systemKey: accountingAccounts.systemKey })
      .from(journalLines)
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(and(
        eq(journalLines.journalEntryId, concurrentEntries[0]!.id),
        eq(accountingAccounts.systemKey, "accounts_payable"),
      ));
    assert.equal(concurrentPayableLines.length, 1, "the concurrent bill should credit accounts payable once");

    for (const expense of [referencedExpense, blankReferenceExpense]) {
      const persistedExpenses = await db.select().from(importExpenses).where(and(
        eq(importExpenses.shipmentId, shipmentId!),
        eq(importExpenses.description, expense.description),
      ));
      assert.equal(persistedExpenses.length, 1, `bill ${expense.description} should have one expense`);
      assert.equal(persistedExpenses[0]!.id, expense.id);
      const entries = await db.select().from(journalEntries).where(and(
        eq(journalEntries.sourceType, "import_expense"),
        eq(journalEntries.sourceId, expense.id),
      ));
      assert.equal(entries.length, 1, `bill ${expense.description} should have one linked journal entry`);
      const payableLines = await db.select({
        systemKey: accountingAccounts.systemKey,
        debitZmw: journalLines.debitZmw,
        creditZmw: journalLines.creditZmw,
      }).from(journalLines)
        .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
        .where(eq(journalLines.journalEntryId, entries[0]!.id));
      assert.deepEqual(payableLines.map((line) => [
        line.systemKey, line.debitZmw, line.creditZmw,
      ]).sort(([left], [right]) => String(left).localeCompare(String(right))), [
        ["landed_cost_clearing", (Number(expense.amount) * Number(expense.exchangeRateToZmw)).toFixed(2), "0.00"],
        ["accounts_payable", "0.00", (Number(expense.amount) * Number(expense.exchangeRateToZmw)).toFixed(2)],
      ].sort(([left], [right]) => String(left).localeCompare(String(right))));
    }

    const distinctBill = {
      ...referencedBill,
      description: `Second distinct forwarder bill ${suffix}`,
      amount: "40.00",
      reference: `FW-SECOND-${suffix}`,
    };
    const { expense: distinctExpense } = await request(distinctBill, 201);
    const shipmentExpenses = await db.select().from(importExpenses)
      .where(eq(importExpenses.shipmentId, shipmentId!));
    assert.equal(shipmentExpenses.length, 4, "the distinct bill should save without duplicating the concurrent bill");
    const distinctEntries = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "import_expense"),
      eq(journalEntries.sourceId, distinctExpense.id),
    ));
    assert.equal(distinctEntries.length, 1, "the distinct bill should receive one payable journal entry");
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
        await client.query("DELETE FROM shipment_lines WHERE shipment_id = $1", [shipmentId]);
        await client.query("DELETE FROM shipment_purchase_orders WHERE shipment_id = $1", [shipmentId]);
        await client.query("DELETE FROM shipments WHERE id = $1", [shipmentId]);
      }
      if (purchaseOrderId) {
        await client.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1", [purchaseOrderId]);
        await client.query("DELETE FROM purchase_orders WHERE id = $1", [purchaseOrderId]);
      }
      if (productId) await client.query("DELETE FROM products WHERE id = $1", [productId]);
      if (supplierId) await client.query("DELETE FROM suppliers WHERE id = $1", [supplierId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});

async function requestToRoute(baseUrl: string, path: string, body: unknown, expectedStatus: number) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as any;
  assert.equal(response.status, expectedStatus, JSON.stringify(payload));
  return payload;
}
