import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test, { after } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  accountingAccounts, businessAuditLogs, businessPayments, customers, importExpenses, inventoryLocations, inventoryMovements,
  inventoryReservations,
  journalEntries, journalLines, paymentReminders, products, purchaseOrderLines, salesOrders, shipmentLines,
  salesDeliveryLines, salesOrderLines, suppliers,
} from "../shared/schema";
import { cents, journalLinesAreBalanced } from "./accounting-posting";

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
  let repeatedProductOrderId: number | undefined;
  let repeatedProductShipmentId: number | undefined;
  let multiProductAId: number | undefined;
  let multiProductBId: number | undefined;
  let multiProductOrderId: number | undefined;
  let multiProductShipmentId: number | undefined;
  let multiProductSalesOrderId: number | undefined;
  let multiProductDeliveryId: number | undefined;
  let mismatchPurchaseOrderId: number | undefined;
  let mismatchShipmentId: number | undefined;
  let mismatchShipmentLineId: number | undefined;
  let mismatchProductAId: number | undefined;
  let mismatchProductBId: number | undefined;
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

    const { order: repeatedProductOrder } = await request("/api/purchase-orders", {
      supplierId,
      currency: "CNY",
      exchangeRateToZmw: "2",
      expectedAt: null,
      notes: null,
      lines: [
        { productId, quantityOrdered: 5, unitPrice: "100.00" },
        { productId, quantityOrdered: 5, unitPrice: "100.00" },
      ],
    }, 201);
    repeatedProductOrderId = repeatedProductOrder.id;
    const repeatedProductOrderLines = await db.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, repeatedProductOrderId!))
      .orderBy(purchaseOrderLines.id);
    assert.equal(repeatedProductOrderLines.length, 2);
    const { shipment: repeatedProductShipment } = await request("/api/shipments", {
      purchaseOrderIds: [repeatedProductOrderId],
      shipmentReference: `ACC-REPEATED-PRODUCT-${suffix}`,
      carrier: null,
      trackingNumber: null,
      shippedAt: null,
      expectedAt: null,
      notes: null,
      lines: repeatedProductOrderLines.map((line: any) => ({
        purchaseOrderLineId: line.id, quantityShipped: 5,
      })),
    }, 201);
    repeatedProductShipmentId = repeatedProductShipment.id;
    const repeatedProductShipmentLines = await db.select().from(shipmentLines)
      .where(eq(shipmentLines.shipmentId, repeatedProductShipmentId!))
      .orderBy(shipmentLines.id);
    assert.equal(repeatedProductShipmentLines.length, 2);
    await patch(`/api/shipments/${repeatedProductShipmentId}/receive`, {
      lines: repeatedProductShipmentLines.map((line: any) => ({
        shipmentLineId: line.id, quantityReceived: 2,
      })),
    }, 200);
    for (const line of repeatedProductShipmentLines) {
      await request(`/api/inventory/receipts/${line.id}/post`, { locationId }, 201);
    }
    await request("/api/import-expenses", {
      purchaseOrderId: repeatedProductOrderId,
      shipmentId: null,
      category: "Freight",
      description: `First repeated-product freight ${suffix}`,
      amount: "100.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-11-19",
      reference: null,
      notes: null,
    }, 201);
    const { orders: [firstRepeatedProductPreviewOrder] } = await request(
      `/api/landed-costs?purchaseOrderId=${repeatedProductOrderId}`, undefined, 200,
    );
    const firstRepeatedProductPreview = firstRepeatedProductPreviewOrder.adjustmentPreview;
    assert.equal(firstRepeatedProductPreview.adjustmentAvailableZmw, "400.00");
    const { journalEntry: firstRepeatedProductAdjustment } = await request(
      `/api/landed-costs/${repeatedProductOrderId}/adjust`,
      {
        reviewedAmountZmw: firstRepeatedProductPreview.adjustmentAvailableZmw,
        reviewedLines: firstRepeatedProductPreview.lines.map((line: any) => ({
          lineId: line.lineId,
          adjustmentZmw: line.adjustmentZmw,
          inventoryZmw: line.inventoryZmw,
          cogsZmw: line.cogsZmw,
        })),
        note: "Adjust first freight bill for repeated product",
      },
      201,
    );
    assert.equal(firstRepeatedProductAdjustment.sourceId, repeatedProductOrderId);

    await request("/api/import-expenses", {
      purchaseOrderId: repeatedProductOrderId,
      shipmentId: null,
      category: "Freight",
      description: `Second repeated-product freight ${suffix}`,
      amount: "50.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-11-19",
      reference: null,
      notes: null,
    }, 201);
    await patch(`/api/shipments/${repeatedProductShipmentId}/receive`, {
      lines: repeatedProductShipmentLines.map((line: any) => ({
        shipmentLineId: line.id, quantityReceived: 3,
      })),
    }, 200);
    for (const line of repeatedProductShipmentLines) {
      await request(`/api/inventory/receipts/${line.id}/post`, { locationId }, 201);
    }
    const { orders: [incrementalRepeatedProductPreviewOrder] } = await request(
      `/api/landed-costs?purchaseOrderId=${repeatedProductOrderId}`, undefined, 200,
    );
    const incrementalRepeatedProductPreview = incrementalRepeatedProductPreviewOrder.adjustmentPreview;
    assert.equal(incrementalRepeatedProductPreview.adjustmentAvailableZmw, "200.00");
    assert.equal(incrementalRepeatedProductPreview.canPost, true);
    assert.equal(incrementalRepeatedProductPreview.hasNegativeLine, false);
    assert.equal(
      incrementalRepeatedProductPreview.lines.reduce(
        (total: number, line: any) => total + Number(line.adjustmentZmw), 0,
      ),
      200,
    );
    const { journalEntry: incrementalRepeatedProductAdjustment } = await request(
      `/api/landed-costs/${repeatedProductOrderId}/adjust`,
      {
        reviewedAmountZmw: incrementalRepeatedProductPreview.adjustmentAvailableZmw,
        reviewedLines: incrementalRepeatedProductPreview.lines.map((line: any) => ({
          lineId: line.lineId,
          adjustmentZmw: line.adjustmentZmw,
          inventoryZmw: line.inventoryZmw,
          cogsZmw: line.cogsZmw,
        })),
        note: "Adjust incremental freight for repeated product",
      },
      201,
    );
    const repeatedProductAdjustmentLines = await db.select({
      journalEntryId: journalLines.journalEntryId,
      accountKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(inArray(journalLines.journalEntryId, [
        firstRepeatedProductAdjustment.id, incrementalRepeatedProductAdjustment.id,
      ]));
    for (const [entryId, expectedAmount] of [
      [firstRepeatedProductAdjustment.id, 400],
      [incrementalRepeatedProductAdjustment.id, 200],
    ]) {
      const lines = repeatedProductAdjustmentLines.filter((line) => line.journalEntryId === entryId);
      assert.equal(journalLinesAreBalanced(lines.map((line) => ({
        accountKey: line.accountKey ?? "",
        debitZmw: line.debitZmw,
        creditZmw: line.creditZmw,
      }))), true);
      assert.equal(lines.reduce((total, line) => total + Number(line.debitZmw), 0), expectedAmount);
      assert.equal(lines.reduce((total, line) => total + Number(line.creditZmw), 0), expectedAmount);
    }

    const [multiProductA] = await db.insert(products).values({
      sku: `ACC-MULTI-A-${suffix}`,
      name: `Accounting multi-product A ${suffix}`,
      status: "active",
      purchaseCurrency: "CNY",
    }).returning();
    multiProductAId = multiProductA.id;
    const [multiProductB] = await db.insert(products).values({
      sku: `ACC-MULTI-B-${suffix}`,
      name: `Accounting multi-product B ${suffix}`,
      status: "active",
      purchaseCurrency: "CNY",
    }).returning();
    multiProductBId = multiProductB.id;
    const { order: multiProductOrder } = await request("/api/purchase-orders", {
      supplierId,
      currency: "CNY",
      exchangeRateToZmw: "2",
      expectedAt: null,
      notes: null,
      lines: [
        { productId: multiProductAId, quantityOrdered: 10, unitPrice: "100.00" },
        { productId: multiProductBId, quantityOrdered: 10, unitPrice: "300.00" },
      ],
    }, 201);
    multiProductOrderId = multiProductOrder.id;
    const multiProductOrderLines = await db.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, multiProductOrderId!))
      .orderBy(purchaseOrderLines.id);
    assert.equal(multiProductOrderLines.length, 2);
    const { shipment: multiProductShipment } = await request("/api/shipments", {
      purchaseOrderIds: [multiProductOrderId],
      shipmentReference: `ACC-MULTI-PRODUCT-${suffix}`,
      carrier: null,
      trackingNumber: null,
      shippedAt: null,
      expectedAt: null,
      notes: null,
      lines: multiProductOrderLines.map((line: any) => ({
        purchaseOrderLineId: line.id, quantityShipped: 10,
      })),
    }, 201);
    multiProductShipmentId = multiProductShipment.id;
    const multiProductShipmentLines = await db.select().from(shipmentLines)
      .where(eq(shipmentLines.shipmentId, multiProductShipmentId!))
      .orderBy(shipmentLines.id);
    await request("/api/import-expenses", {
      purchaseOrderId: multiProductOrderId,
      shipmentId: null,
      category: "Freight",
      description: `Initial multi-product freight ${suffix}`,
      amount: "40.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-11-19",
      reference: null,
      notes: null,
    }, 201);
    await patch(`/api/shipments/${multiProductShipmentId}/receive`, {
      lines: multiProductShipmentLines.map((line: any) => ({
        shipmentLineId: line.id, quantityReceived: 4,
      })),
    }, 200);
    for (const line of multiProductShipmentLines) {
      await request(`/api/inventory/receipts/${line.id}/post`, { locationId }, 201);
    }

    await request("/api/import-expenses", {
      purchaseOrderId: multiProductOrderId,
      shipmentId: null,
      category: "Freight",
      description: `Second multi-product freight ${suffix}`,
      amount: "20.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-11-19",
      reference: null,
      notes: null,
    }, 201);
    const { order: multiProductSalesOrder } = await request("/api/sales-orders", {
      customerId,
      deliveryAddress: null,
      notes: null,
      lines: [{ productId: multiProductAId, quantity: 2, unitPriceZmw: "500.00" }],
    }, 201);
    multiProductSalesOrderId = multiProductSalesOrder.id;
    await request(`/api/sales-orders/${multiProductSalesOrderId}/confirm`, {}, 200);
    const [multiProductSalesLine] = await db.select().from(salesOrderLines)
      .where(eq(salesOrderLines.salesOrderId, multiProductSalesOrderId!));
    const { delivery: multiProductDelivery } = await request(
      `/api/sales-orders/${multiProductSalesOrderId}/deliveries`,
      {
        idempotencyKey: randomUUID(),
        deliveryDate: "2026-11-19",
        lines: [{ salesOrderLineId: multiProductSalesLine.id, quantity: 2 }],
      },
      201,
    );
    multiProductDeliveryId = multiProductDelivery.id;

    const { orders: [initialMultiProductOrder] } = await request(
      `/api/landed-costs?purchaseOrderId=${multiProductOrderId}`, undefined, 200,
    );
    const initialMultiProductPreview = initialMultiProductOrder.adjustmentPreview;
    assert.equal(initialMultiProductPreview.allocatedExpensesZmw, "600.00");
    assert.equal(initialMultiProductPreview.receiptClearedTotalZmw, "160.00");
    assert.equal(initialMultiProductPreview.clearingBalanceZmw, "440.00");
    assert.equal(initialMultiProductPreview.adjustmentAvailableZmw, "80.00");
    assert.equal(initialMultiProductPreview.unpostedClearingZmw, "360.00");
    assert.deepEqual(initialMultiProductPreview.lines.map((line: any) => [
      line.productId, line.stockedQuantity, line.onHand, line.adjustmentZmw,
      line.inventoryZmw, line.cogsZmw,
    ]), [
      [multiProductAId, 4, 2, "20.00", "10.00", "10.00"],
      [multiProductBId, 4, 4, "60.00", "60.00", "0.00"],
    ]);
    const { journalEntry: initialMultiProductAdjustment } = await request(
      `/api/landed-costs/${multiProductOrderId}/adjust`,
      {
        reviewedAmountZmw: initialMultiProductPreview.adjustmentAvailableZmw,
        reviewedLines: initialMultiProductPreview.lines.map((line: any) => ({
          lineId: line.lineId,
          adjustmentZmw: line.adjustmentZmw,
          inventoryZmw: line.inventoryZmw,
          cogsZmw: line.cogsZmw,
        })),
        note: "Review initial freight split across products",
      },
      201,
    );
    assert.equal(initialMultiProductAdjustment.sourceId, multiProductOrderId);

    await request("/api/import-expenses", {
      purchaseOrderId: multiProductOrderId,
      shipmentId: null,
      category: "Freight",
      description: `Later multi-product freight ${suffix}`,
      amount: "10.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-11-20",
      reference: null,
      notes: null,
    }, 201);
    await patch(`/api/shipments/${multiProductShipmentId}/receive`, {
      lines: multiProductShipmentLines.map((line: any) => ({
        shipmentLineId: line.id, quantityReceived: 7,
      })),
    }, 200);
    for (const line of multiProductShipmentLines) {
      await request(`/api/inventory/receipts/${line.id}/post`, { locationId }, 201);
    }
    const { orders: [incrementalMultiProductOrder] } = await request(
      `/api/landed-costs?purchaseOrderId=${multiProductOrderId}`, undefined, 200,
    );
    const incrementalMultiProductPreview = incrementalMultiProductOrder.adjustmentPreview;
    assert.equal(incrementalMultiProductPreview.allocatedExpensesZmw, "700.00");
    assert.equal(incrementalMultiProductPreview.receiptClearedTotalZmw, "370.00");
    assert.equal(incrementalMultiProductPreview.priorAdjustmentsClearedZmw, "80.00");
    assert.equal(incrementalMultiProductPreview.clearingBalanceZmw, "250.00");
    assert.equal(incrementalMultiProductPreview.adjustmentAvailableZmw, "40.00");
    assert.equal(incrementalMultiProductPreview.unpostedClearingZmw, "210.00");
    assert.deepEqual(incrementalMultiProductPreview.receipts.map((receipt: any) => [
      receipt.productName, receipt.quantity, receipt.clearedAmountZmw,
    ]), [
      [multiProductA.name, 4, "40.00"],
      [multiProductB.name, 4, "120.00"],
      [multiProductA.name, 3, "52.50"],
      [multiProductB.name, 3, "157.50"],
    ]);
    assert.deepEqual(incrementalMultiProductPreview.lines.map((line: any) => [
      line.productId, line.stockedQuantity, line.onHand, line.adjustmentZmw,
      line.inventoryZmw, line.cogsZmw,
    ]), [
      [multiProductAId, 7, 5, "10.00", "7.14", "2.86"],
      [multiProductBId, 7, 7, "30.00", "30.00", "0.00"],
    ]);
    const { journalEntry: incrementalMultiProductAdjustment } = await request(
      `/api/landed-costs/${multiProductOrderId}/adjust`,
      {
        reviewedAmountZmw: incrementalMultiProductPreview.adjustmentAvailableZmw,
        reviewedLines: incrementalMultiProductPreview.lines.map((line: any) => ({
          lineId: line.lineId,
          adjustmentZmw: line.adjustmentZmw,
          inventoryZmw: line.inventoryZmw,
          cogsZmw: line.cogsZmw,
        })),
        note: "Review incremental freight split across products",
      },
      201,
    );
    assert.equal(incrementalMultiProductAdjustment.sourceId, multiProductOrderId);

    const multiProductAdjustmentEntries = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "landed_cost_adjustment"),
      eq(journalEntries.sourceId, multiProductOrderId!),
    ));
    assert.deepEqual(
      multiProductAdjustmentEntries.map((entry) => entry.id).sort(),
      [initialMultiProductAdjustment.id, incrementalMultiProductAdjustment.id].sort(),
    );
    const multiProductJournalLines = await db.select({
      journalEntryId: journalLines.journalEntryId,
      accountKey: accountingAccounts.systemKey,
      productId: journalLines.productId,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(inArray(journalLines.journalEntryId, [
        initialMultiProductAdjustment.id, incrementalMultiProductAdjustment.id,
      ]));
    for (const [entryId, expectedLines] of [
      [initialMultiProductAdjustment.id, [
        ["inventory", multiProductAId, "10.00", "0.00"],
        ["cost_of_goods_sold", multiProductAId, "10.00", "0.00"],
        ["inventory", multiProductBId, "60.00", "0.00"],
        ["landed_cost_clearing", null, "0.00", "80.00"],
      ]],
      [incrementalMultiProductAdjustment.id, [
        ["inventory", multiProductAId, "7.14", "0.00"],
        ["cost_of_goods_sold", multiProductAId, "2.86", "0.00"],
        ["inventory", multiProductBId, "30.00", "0.00"],
        ["landed_cost_clearing", null, "0.00", "40.00"],
      ]],
    ] as [number, (string | number | null)[][]][]) {
      const lines = multiProductJournalLines.filter((line) => line.journalEntryId === entryId);
      assert.deepEqual(lines.map((line) => [
        line.accountKey, line.productId, line.debitZmw, line.creditZmw,
      ]).sort((left, right) => String(left[0]).localeCompare(String(right[0])) || Number(left[1] ?? 0) - Number(right[1] ?? 0)),
      expectedLines.sort((left, right) => String(left[0]).localeCompare(String(right[0])) || Number(left[1] ?? 0) - Number(right[1] ?? 0)));
      assert.equal(journalLinesAreBalanced(lines.map((line) => ({
        accountKey: line.accountKey ?? "",
        debitZmw: line.debitZmw,
        creditZmw: line.creditZmw,
      }))), true, `Multi-product adjustment journal ${entryId} is unbalanced`);
    }
    const { orders: [afterIncrementalMultiProductAdjustment] } = await request(
      `/api/landed-costs?purchaseOrderId=${multiProductOrderId}`, undefined, 200,
    );
    assert.equal(afterIncrementalMultiProductAdjustment.adjustmentPreview.clearingBalanceZmw, "210.00");
    assert.equal(afterIncrementalMultiProductAdjustment.adjustmentPreview.adjustmentAvailableZmw, "0.00");
    assert.equal(afterIncrementalMultiProductAdjustment.adjustmentPreview.unpostedClearingZmw, "210.00");

    const [mismatchProductA] = await db.insert(products).values({
      sku: `ACC-MISMATCH-A-${suffix}`,
      name: `Receipt mismatch product A ${suffix}`,
      status: "active",
      purchaseCurrency: "CNY",
    }).returning();
    const [mismatchProductB] = await db.insert(products).values({
      sku: `ACC-MISMATCH-B-${suffix}`,
      name: `Receipt mismatch product B ${suffix}`,
      status: "active",
      purchaseCurrency: "CNY",
    }).returning();
    mismatchProductAId = mismatchProductA.id;
    mismatchProductBId = mismatchProductB.id;
    assert.notEqual(mismatchProductAId, mismatchProductBId);
    const { order: mismatchOrder } = await request("/api/purchase-orders", {
      supplierId,
      currency: "CNY",
      exchangeRateToZmw: "2",
      expectedAt: null,
      notes: null,
      lines: [
        { productId: mismatchProductAId, quantityOrdered: 10, unitPrice: "100.00" },
        { productId: mismatchProductBId, quantityOrdered: 10, unitPrice: "100.00" },
      ],
    }, 201);
    mismatchPurchaseOrderId = mismatchOrder.id;
    const mismatchOrderLines = await db.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, mismatchPurchaseOrderId!))
      .orderBy(purchaseOrderLines.id);
    const { shipment: mismatchShipment } = await request("/api/shipments", {
      purchaseOrderIds: [mismatchPurchaseOrderId],
      shipmentReference: `ACC-MISMATCH-SHIP-${suffix}`,
      carrier: null,
      trackingNumber: null,
      shippedAt: null,
      expectedAt: null,
      notes: null,
      lines: mismatchOrderLines.map((line) => ({
        purchaseOrderLineId: line.id, quantityShipped: 10,
      })),
    }, 201);
    mismatchShipmentId = mismatchShipment.id;
    const mismatchShipmentLines = await db.select().from(shipmentLines)
      .where(eq(shipmentLines.shipmentId, mismatchShipmentId!))
      .orderBy(shipmentLines.id);
    mismatchShipmentLineId = mismatchShipmentLines[0].id;
    await request("/api/import-expenses", {
      purchaseOrderId: mismatchPurchaseOrderId,
      shipmentId: null,
      category: "Freight",
      description: `Initial receipt clearing mismatch freight ${suffix}`,
      amount: "100.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-11-19",
      reference: null,
      notes: null,
    }, 201);
    await patch(`/api/shipments/${mismatchShipmentId}/receive`, {
      lines: mismatchShipmentLines.map((line: any) => ({
        shipmentLineId: line.id, quantityReceived: 4,
      })),
    }, 200);
    for (const line of mismatchShipmentLines) {
      await request(`/api/inventory/receipts/${line.id}/post`, { locationId }, 201);
    }
    await request("/api/import-expenses", {
      purchaseOrderId: mismatchPurchaseOrderId,
      shipmentId: null,
      category: "Freight",
      description: `Late receipt clearing mismatch freight ${suffix}`,
      amount: "40.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-11-20",
      reference: null,
      notes: null,
    }, 201);
    const [mismatchMovement] = await db.select().from(inventoryMovements)
      .where(eq(inventoryMovements.sourceKey, `shipment-line-${mismatchShipmentLineId}-to-4`));
    const [mismatchReceiptEntry] = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "stock_receipt"),
      eq(journalEntries.sourceId, mismatchMovement.id),
    ));
    await db.update(journalEntries).set({ shipmentLineId: null })
      .where(eq(journalEntries.id, mismatchReceiptEntry.id));
    const otherProductShipmentLine = mismatchShipmentLines.find((line) => line.id !== mismatchShipmentLineId);
    assert.ok(otherProductShipmentLine);
    const otherProductOrderLine = mismatchOrderLines.find(
      (line) => line.id === otherProductShipmentLine.purchaseOrderLineId,
    );
    assert.ok(otherProductOrderLine);
    assert.notEqual(otherProductOrderLine.productId, mismatchMovement.productId);
    await request(`/api/inventory/receipt-journals/${mismatchReceiptEntry.id}/link`, {
      shipmentLineId: otherProductShipmentLine.id,
    }, 400);
    const [stillUnlinkedReceiptEntry] = await db.select().from(journalEntries)
      .where(eq(journalEntries.id, mismatchReceiptEntry.id));
    assert.equal(stillUnlinkedReceiptEntry.shipmentLineId, null);
    const rejectedLinkAudits = await db.select().from(businessAuditLogs).where(and(
      eq(businessAuditLogs.entityType, "journal_entry"),
      eq(businessAuditLogs.entityId, mismatchReceiptEntry.id),
      eq(businessAuditLogs.actorEmail, testEmail),
      eq(businessAuditLogs.action, "updated"),
    ));
    assert.ok(rejectedLinkAudits.every((audit) => !audit.changedFields.includes("shipmentLineId")));
    // Simulate a receipt movement larger than the matching shipment line's
    // stocked quantity, so this request reaches the capacity conflict branch
    // instead of failing the earlier product-identity validation.
    await db.update(inventoryMovements).set({ quantityDelta: 5 })
      .where(eq(inventoryMovements.id, mismatchMovement.id));
    const overCapacityLink = await fetch(`${baseUrl}/api/inventory/receipt-journals/${mismatchReceiptEntry.id}/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shipmentLineId: mismatchShipmentLineId }),
    });
    assert.equal(overCapacityLink.status, 409);
    await db.update(inventoryMovements).set({ quantityDelta: 4 })
      .where(eq(inventoryMovements.id, mismatchMovement.id));
    await request(`/api/inventory/receipt-journals/${mismatchReceiptEntry.id}/link`, {
      shipmentLineId: mismatchShipmentLineId,
    }, 200);
    const [clearingAccount] = await db.select().from(accountingAccounts)
      .where(eq(accountingAccounts.systemKey, "landed_cost_clearing"));
    const [receiptClearingLine] = await db.select().from(journalLines).where(and(
      eq(journalLines.journalEntryId, mismatchReceiptEntry.id),
      eq(journalLines.accountId, clearingAccount.id),
    ));
    // Product A should clear 200.00 ZMW; corrupt it by one ZMW. Product B
    // remains valid and has a positive late-cost adjustment from the later bill.
    await db.update(journalLines).set({ creditZmw: "201.00" })
      .where(eq(journalLines.id, receiptClearingLine.id));

    const { orders: [mismatchPreviewOrder] } = await request(
      `/api/landed-costs?purchaseOrderId=${mismatchPurchaseOrderId}`, undefined, 200,
    );
    const mismatchPreview = mismatchPreviewOrder.adjustmentPreview;
    assert.equal(mismatchPreview.hasNegativeLine, true);
    assert.equal(mismatchPreview.canPost, false);
    assert.equal(mismatchPreview.adjustmentAvailableZmw, "80.00");
    assert.deepEqual(mismatchPreview.lines.map((line: any) => [
      line.productId, line.stockedQuantity, line.adjustmentZmw,
    ]), [
      [mismatchProductAId, 4, "-1.00"],
      [mismatchProductBId, 4, "80.00"],
    ]);

    const mismatchAdjustmentRequest = {
      reviewedAmountZmw: mismatchPreview.adjustmentAvailableZmw,
      reviewedLines: mismatchPreview.lines.map((line: any) => ({
        lineId: line.lineId,
        adjustmentZmw: line.adjustmentZmw,
        inventoryZmw: line.inventoryZmw,
        cogsZmw: line.cogsZmw,
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
      if (productId || multiProductAId || multiProductBId || mismatchProductAId || mismatchProductBId) {
        await client.query(`
          DELETE FROM journal_lines
          WHERE journal_entry_id IN (
            SELECT id FROM journal_entries
            WHERE (source_type = 'import_expense' AND source_id IN (
              SELECT id FROM import_expenses WHERE purchase_order_id = ANY($1::int[])
            ))
            OR (source_type = 'stock_receipt' AND source_id IN (
              SELECT id FROM inventory_movements WHERE product_id = ANY($2::int[])
            ))
            OR (source_type = 'landed_cost_adjustment' AND source_id = ANY($1::int[]))
            OR (source_type IN ('sales_delivery', 'sales_delivery_cogs') AND source_id IN (
              SELECT id FROM sales_deliveries WHERE sales_order_id = ANY($3::int[])
            ))
            OR (source_type IN ('sales_return', 'sales_return_cogs') AND source_id IN (
              SELECT id FROM inventory_movements WHERE sales_delivery_line_id IN (
                SELECT id FROM sales_delivery_lines WHERE delivery_id IN (
                  SELECT id FROM sales_deliveries WHERE sales_order_id = ANY($3::int[])
                )
              )
            ))
          )
        `, [
          [purchaseOrderId, mismatchPurchaseOrderId, repeatedProductOrderId, multiProductOrderId].filter(Boolean),
          [productId, multiProductAId, multiProductBId, mismatchProductAId, mismatchProductBId].filter(Boolean),
          [salesOrderId, multiProductSalesOrderId].filter(Boolean),
        ]);
        await client.query(`
          DELETE FROM journal_entries
          WHERE (source_type = 'import_expense' AND source_id IN (
            SELECT id FROM import_expenses WHERE purchase_order_id = ANY($1::int[])
          ))
          OR (source_type = 'stock_receipt' AND source_id IN (
            SELECT id FROM inventory_movements WHERE product_id = ANY($2::int[])
          ))
          OR (source_type = 'landed_cost_adjustment' AND source_id = ANY($1::int[]))
          OR (source_type IN ('sales_delivery', 'sales_delivery_cogs') AND source_id IN (
            SELECT id FROM sales_deliveries WHERE sales_order_id = ANY($3::int[])
          ))
          OR (source_type IN ('sales_return', 'sales_return_cogs') AND source_id IN (
            SELECT id FROM inventory_movements WHERE sales_delivery_line_id IN (
              SELECT id FROM sales_delivery_lines WHERE delivery_id IN (
                SELECT id FROM sales_deliveries WHERE sales_order_id = ANY($3::int[])
              )
            )
          ))
        `, [
          [purchaseOrderId, mismatchPurchaseOrderId, repeatedProductOrderId, multiProductOrderId].filter(Boolean),
          [productId, multiProductAId, multiProductBId, mismatchProductAId, mismatchProductBId].filter(Boolean),
          [salesOrderId, multiProductSalesOrderId].filter(Boolean),
        ]);
        await client.query("DELETE FROM inventory_movements WHERE product_id = ANY($1::int[])", [
          [productId, multiProductAId, multiProductBId, mismatchProductAId, mismatchProductBId].filter(Boolean),
        ]);
      }
      if (deliveryId) await client.query(
        "DELETE FROM sales_delivery_lines WHERE delivery_id = $1", [deliveryId],
      );
      if (deliveryId) await client.query("DELETE FROM sales_deliveries WHERE id = $1", [deliveryId]);
      if (multiProductDeliveryId) await client.query(
        "DELETE FROM sales_delivery_lines WHERE delivery_id = $1", [multiProductDeliveryId],
      );
      if (multiProductDeliveryId) await client.query(
        "DELETE FROM sales_deliveries WHERE id = $1", [multiProductDeliveryId],
      );
      if (salesOrderId) {
        await client.query("DELETE FROM inventory_reservations WHERE sales_order_id = $1", [salesOrderId]);
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [salesOrderId]);
        await client.query("DELETE FROM sales_orders WHERE id = $1", [salesOrderId]);
      }
      if (multiProductSalesOrderId) {
        await client.query("DELETE FROM inventory_reservations WHERE sales_order_id = $1", [multiProductSalesOrderId]);
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [multiProductSalesOrderId]);
        await client.query("DELETE FROM sales_orders WHERE id = $1", [multiProductSalesOrderId]);
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
      if (repeatedProductOrderId) {
        await client.query("DELETE FROM import_expenses WHERE purchase_order_id = $1", [repeatedProductOrderId]);
        if (repeatedProductShipmentId) {
          await client.query("DELETE FROM shipment_lines WHERE shipment_id = $1", [repeatedProductShipmentId]);
          await client.query("DELETE FROM shipment_purchase_orders WHERE shipment_id = $1", [repeatedProductShipmentId]);
          await client.query("DELETE FROM shipments WHERE id = $1", [repeatedProductShipmentId]);
        }
        await client.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1", [repeatedProductOrderId]);
        await client.query("DELETE FROM purchase_orders WHERE id = $1", [repeatedProductOrderId]);
      }
      if (multiProductOrderId) {
        await client.query("DELETE FROM import_expenses WHERE purchase_order_id = $1", [multiProductOrderId]);
        if (multiProductShipmentId) {
          await client.query("DELETE FROM shipment_lines WHERE shipment_id = $1", [multiProductShipmentId]);
          await client.query("DELETE FROM shipment_purchase_orders WHERE shipment_id = $1", [multiProductShipmentId]);
          await client.query("DELETE FROM shipments WHERE id = $1", [multiProductShipmentId]);
        }
        await client.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1", [multiProductOrderId]);
        await client.query("DELETE FROM purchase_orders WHERE id = $1", [multiProductOrderId]);
      }
      if (productId) await client.query("DELETE FROM products WHERE id = $1", [productId]);
      if (multiProductAId) await client.query("DELETE FROM products WHERE id = $1", [multiProductAId]);
      if (multiProductBId) await client.query("DELETE FROM products WHERE id = $1", [multiProductBId]);
      if (mismatchProductAId) await client.query("DELETE FROM products WHERE id = $1", [mismatchProductAId]);
      if (mismatchProductBId) await client.query("DELETE FROM products WHERE id = $1", [mismatchProductBId]);
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

test("correcting receipt clearing restores a postable landed-cost adjustment", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [
    { db, pool },
    { registerProcurementRoutes },
    { registerInventoryRoutes },
  ] = await Promise.all([
    import("./db"),
    import("./procurement-routes"),
    import("./inventory-routes"),
  ]);
  closeIntegrationPool = () => pool.end();

  const suffix = randomUUID();
  const testEmail = `receipt-clearing-repair-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: testEmail, role: "owner" };
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
  let locationId: number | undefined;
  let purchaseOrderId: number | undefined;
  let shipmentId: number | undefined;

  const request = async (path: string, body: unknown, expectedStatus: number) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const responseText = await response.text();
    let payload: any;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error(`Expected a JSON response from ${path}, got ${response.status}: ${responseText.slice(0, 1000)}`);
    }
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
      name: `Receipt repair supplier ${suffix}`,
    }).returning();
    supplierId = supplier.id;
    const [product] = await db.insert(products).values({
      sku: `ACC-REPAIR-${suffix}`,
      name: `Receipt repair product ${suffix}`,
      status: "active",
      purchaseCurrency: "CNY",
    }).returning();
    productId = product.id;
    const [location] = await db.insert(inventoryLocations).values({
      name: `Receipt repair location ${suffix}`,
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
      shipmentReference: `ACC-REPAIR-SHIP-${suffix}`,
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
    await request("/api/import-expenses", {
      purchaseOrderId,
      shipmentId: null,
      category: "Freight",
      description: `Before-receipt freight ${suffix}`,
      amount: "100.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-11-19",
      reference: null,
      notes: null,
    }, 201);
    await patch(`/api/shipments/${shipmentId}/receive`, {
      lines: [{ shipmentLineId: shipmentLine.id, quantityReceived: 4 }],
    }, 200);
    await request(`/api/inventory/receipts/${shipmentLine.id}/post`, { locationId }, 201);
    await request("/api/import-expenses", {
      purchaseOrderId,
      shipmentId: null,
      category: "Freight",
      description: `After-receipt freight ${suffix}`,
      amount: "20.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-11-20",
      reference: null,
      notes: null,
    }, 201);

    const [movement] = await db.select().from(inventoryMovements)
      .where(eq(inventoryMovements.sourceKey, `shipment-line-${shipmentLine.id}-to-4`));
    const [receiptEntry] = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "stock_receipt"),
      eq(journalEntries.sourceId, movement.id),
    ));
    const [clearingAccount] = await db.select().from(accountingAccounts)
      .where(eq(accountingAccounts.systemKey, "landed_cost_clearing"));
    const [receiptClearingLine] = await db.select().from(journalLines).where(and(
      eq(journalLines.journalEntryId, receiptEntry.id),
      eq(journalLines.accountId, clearingAccount.id),
    ));
    // The original posted share is 400.00; recording 481.00 makes the current
    // difference negative despite the later 80.00 adjustment.
    await db.update(journalLines).set({ creditZmw: "481.00" })
      .where(eq(journalLines.id, receiptClearingLine.id));
    const { orders: [mismatchedOrder] } = await request(
      `/api/landed-costs?purchaseOrderId=${purchaseOrderId}`, undefined, 200,
    );
    assert.equal(mismatchedOrder.adjustmentPreview.hasNegativeLine, true,
      JSON.stringify(mismatchedOrder.adjustmentPreview));
    assert.equal(mismatchedOrder.adjustmentPreview.canPost, false);
    assert.equal(mismatchedOrder.adjustmentPreview.lines[0].adjustmentZmw, "-1.00");

    const adjustmentRequestFor = (preview: any) => ({
      reviewedAmountZmw: preview.adjustmentAvailableZmw,
      reviewedLines: preview.lines.map((line: any) => ({
        lineId: line.lineId,
        adjustmentZmw: line.adjustmentZmw,
        inventoryZmw: line.inventoryZmw,
        cogsZmw: line.cogsZmw,
      })),
      note: "Repair receipt clearing history",
    });
    await request(`/api/landed-costs/${purchaseOrderId}/adjust`,
      adjustmentRequestFor(mismatchedOrder.adjustmentPreview), 409);

    await db.update(journalLines).set({ creditZmw: "400.00" })
      .where(eq(journalLines.id, receiptClearingLine.id));
    const { orders: [repairedOrder] } = await request(
      `/api/landed-costs?purchaseOrderId=${purchaseOrderId}`, undefined, 200,
    );
    const preview = repairedOrder.adjustmentPreview;
    assert.equal(preview.receipts[0].clearedAmountZmw, "400.00");
    assert.equal(preview.hasNegativeLine, false);
    assert.equal(preview.canPost, true);
    assert.equal(preview.adjustmentAvailableZmw, "80.00");
    assert.equal(preview.lines[0].adjustmentZmw, "80.00");

    const { journalEntry } = await request(
      `/api/landed-costs/${purchaseOrderId}/adjust`,
      adjustmentRequestFor(preview),
      201,
    );
    const postedLines = await db.select({
      systemKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalLines.journalEntryId, journalEntry.id));
    assert.deepEqual(postedLines.map((line) => [
      line.systemKey, line.debitZmw, line.creditZmw,
    ]), [
      ["inventory", "80.00", "0.00"],
      ["landed_cost_clearing", "0.00", "80.00"],
    ]);
    assert.equal(journalLinesAreBalanced(postedLines.map((line) => ({
      accountKey: line.systemKey ?? "",
      debitZmw: line.debitZmw,
      creditZmw: line.creditZmw,
    }))), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [testEmail]);
      if (purchaseOrderId) {
        await client.query(`
          DELETE FROM journal_lines WHERE journal_entry_id IN (
            SELECT id FROM journal_entries
            WHERE (source_type = 'import_expense' AND source_id IN (
              SELECT id FROM import_expenses WHERE purchase_order_id = $1
            ))
            OR (source_type = 'stock_receipt' AND source_id IN (
              SELECT id FROM inventory_movements WHERE product_id = $2
            ))
            OR (source_type = 'landed_cost_adjustment' AND source_id = $1)
          )
        `, [purchaseOrderId, productId]);
        await client.query(`
          DELETE FROM journal_entries
          WHERE (source_type = 'import_expense' AND source_id IN (
            SELECT id FROM import_expenses WHERE purchase_order_id = $1
          ))
          OR (source_type = 'stock_receipt' AND source_id IN (
            SELECT id FROM inventory_movements WHERE product_id = $2
          ))
          OR (source_type = 'landed_cost_adjustment' AND source_id = $1)
        `, [purchaseOrderId, productId]);
        await client.query("DELETE FROM inventory_movements WHERE product_id = $1", [productId]);
        await client.query("DELETE FROM import_expenses WHERE purchase_order_id = $1", [purchaseOrderId]);
      }
      if (shipmentId) {
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

test("repeated opening-stock corrections stay linked to the latest count", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db, pool }, { registerInventoryRoutes }] = await Promise.all([
    import("./db"),
    import("./inventory-routes"),
  ]);
  closeIntegrationPool = () => pool.end();

  const suffix = randomUUID();
  const actorEmail = `opening-stock-corrections-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerInventoryRoutes(app, owner);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let productId: number | undefined;
  let locationId: number | undefined;
  try {
    const [product] = await db.insert(products).values({
      sku: `OPENING-CHAIN-${suffix}`,
      name: `Repeated opening count ${suffix}`,
      status: "active",
      purchaseCurrency: "CNY",
    }).returning();
    productId = product.id;
    const [location] = await db.insert(inventoryLocations).values({
      name: `Opening correction location ${suffix}`,
    }).returning();
    locationId = location.id;

    const openingResponse = await fetch(`${baseUrl}/api/inventory/opening-stock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        productId, locationId, quantity: 10, unitCostZmw: "25.00",
        effectiveAt: "2026-11-19", memo: "Initial physical count", reference: null,
      }),
    });
    const openingPayload = await openingResponse.json() as any;
    assert.equal(openingResponse.status, 201, JSON.stringify(openingPayload));
    const original = openingPayload.movement;

    const firstResponse = await fetch(`${baseUrl}/api/inventory/opening-stock/${original.id}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quantity: 8, unitCostZmw: "30.00", effectiveAt: "2026-11-19",
        reason: "First recount", reference: "COUNT-2",
      }),
    });
    const firstPayload = await firstResponse.json() as any;
    assert.equal(firstResponse.status, 201, JSON.stringify(firstPayload));
    const firstReversal = firstPayload.reversal;
    const firstReplacement = firstPayload.movement;

    const staleTargetResponse = await fetch(`${baseUrl}/api/inventory/opening-stock/${original.id}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quantity: 6, unitCostZmw: "35.00", effectiveAt: "2026-11-19",
        reason: "Second recount", reference: "COUNT-3",
      }),
    });
    const staleTargetPayload = await staleTargetResponse.json() as any;
    assert.equal(staleTargetResponse.status, 409, JSON.stringify(staleTargetPayload));
    assert.match(staleTargetPayload.error, /latest replacement/i);

    const secondResponse = await fetch(`${baseUrl}/api/inventory/opening-stock/${firstReplacement.id}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quantity: 6, unitCostZmw: "35.00", effectiveAt: "2026-11-19",
        reason: "Second recount", reference: "COUNT-3",
      }),
    });
    const secondPayload = await secondResponse.json() as any;
    assert.equal(secondResponse.status, 201, JSON.stringify(secondPayload));
    const secondReversal = secondPayload.reversal;
    const finalReplacement = secondPayload.movement;

    const expectedMovements = [
      { id: original.id, kind: "opening_stock", quantityDelta: 10, correctionOfMovementId: null },
      { id: firstReversal.id, kind: "opening_stock_reversal", quantityDelta: -10, correctionOfMovementId: original.id },
      { id: firstReplacement.id, kind: "opening_stock", quantityDelta: 8, correctionOfMovementId: firstReversal.id },
      { id: secondReversal.id, kind: "opening_stock_reversal", quantityDelta: -8, correctionOfMovementId: firstReplacement.id },
      { id: finalReplacement.id, kind: "opening_stock", quantityDelta: 6, correctionOfMovementId: secondReversal.id },
    ];
    const movementRows = await db.select().from(inventoryMovements)
      .where(eq(inventoryMovements.productId, productId));
    assert.deepEqual(
      movementRows.map(({ id, kind, quantityDelta, correctionOfMovementId }) => ({
        id, kind, quantityDelta, correctionOfMovementId,
      })).sort((a, b) => a.id - b.id),
      expectedMovements.sort((a, b) => a.id - b.id),
    );
    assert.equal(movementRows.reduce((total, movement) => total + movement.quantityDelta, 0), 6);

    const historyResponse = await fetch(`${baseUrl}/api/inventory/movements`);
    const historyPayload = await historyResponse.json() as { movements: any[] };
    assert.equal(historyResponse.status, 200, JSON.stringify(historyPayload));
    const visibleChain = historyPayload.movements.filter((movement) => expectedMovements
      .some((expected) => expected.id === movement.id));
    assert.equal(visibleChain.length, 5);
    assert.ok(expectedMovements.every((expected) => visibleChain.some((movement) =>
      movement.id === expected.id && movement.correctionOfMovementId === expected.correctionOfMovementId)));

    const movementIds = expectedMovements.map((movement) => movement.id);
    const entries = await db.select().from(journalEntries).where(and(
      inArray(journalEntries.sourceType, ["opening_stock", "opening_stock_reversal"]),
      inArray(journalEntries.sourceId, movementIds),
    ));
    assert.equal(entries.length, 5);
    assert.deepEqual(
      entries.map((entry) => [entry.sourceType, entry.sourceId]).sort((a, b) => Number(a[1]) - Number(b[1])),
      expectedMovements.map((movement) => [
        movement.kind === "opening_stock_reversal" ? "opening_stock_reversal" : "opening_stock",
        movement.id,
      ]).sort((a, b) => Number(a[1]) - Number(b[1])),
    );

    const journalRows = await db.select({
      journalEntryId: journalLines.journalEntryId,
      accountKey: accountingAccounts.systemKey,
      productId: journalLines.productId,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(inArray(journalLines.journalEntryId, entries.map((entry) => entry.id)));
    for (const entry of entries) {
      const lines = journalRows.filter((line) => line.journalEntryId === entry.id);
      assert.equal(journalLinesAreBalanced(lines.map((line) => ({
        accountKey: line.accountKey ?? "",
        debitZmw: line.debitZmw,
        creditZmw: line.creditZmw,
      }))), true, `Journal ${entry.id} is unbalanced`);
    }
    const inventoryValueCents = journalRows
      .filter((line) => line.accountKey === "inventory" && line.productId === productId)
      .reduce((total, line) => total + cents(line.debitZmw) - cents(line.creditZmw), 0n);
    assert.equal(inventoryValueCents, 21000n);

    const inventoryResponse = await fetch(`${baseUrl}/api/inventory`);
    const inventoryPayload = await inventoryResponse.json() as { inventory: any[] };
    assert.equal(inventoryResponse.status, 200, JSON.stringify(inventoryPayload));
    const finalInventory = inventoryPayload.inventory.find((item) => item.id === productId);
    assert.ok(finalInventory);
    assert.equal(finalInventory.onHand, 6);
    assert.equal(finalInventory.stockValueZmw, "210.00");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (productId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
        await client.query(`
          DELETE FROM journal_lines
          WHERE journal_entry_id IN (
            SELECT id FROM journal_entries
            WHERE source_id IN (
              SELECT id FROM inventory_movements WHERE product_id = $1
            )
              AND source_type IN ('opening_stock', 'opening_stock_reversal')
          )
        `, [productId]);
        await client.query(`
          DELETE FROM journal_entries
          WHERE source_id IN (
            SELECT id FROM inventory_movements WHERE product_id = $1
          )
            AND source_type IN ('opening_stock', 'opening_stock_reversal')
        `, [productId]);
        await client.query(
          "UPDATE inventory_movements SET correction_of_movement_id = NULL WHERE product_id = $1",
          [productId],
        );
        await client.query("DELETE FROM inventory_movements WHERE product_id = $1", [productId]);
        await client.query("DELETE FROM products WHERE id = $1", [productId]);
        if (locationId) await client.query("DELETE FROM inventory_locations WHERE id = $1", [locationId]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }
});

test("opening-stock corrections cannot reduce stock below active reservations", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db, pool }, { registerInventoryRoutes }] = await Promise.all([
    import("./db"),
    import("./inventory-routes"),
  ]);
  closeIntegrationPool = () => pool.end();

  const suffix = randomUUID();
  const actorEmail = `opening-stock-reservation-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerInventoryRoutes(app, owner);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let productId: number | undefined;
  let locationId: number | undefined;
  try {
    const [product] = await db.insert(products).values({
      sku: `OPENING-RESERVATION-${suffix}`,
      name: `Reserved opening stock ${suffix}`,
      status: "active",
      purchaseCurrency: "CNY",
    }).returning();
    productId = product.id;
    const [location] = await db.insert(inventoryLocations).values({
      name: `Opening reservation location ${suffix}`,
    }).returning();
    locationId = location.id;

    const openingResponse = await fetch(`${baseUrl}/api/inventory/opening-stock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        productId, locationId, quantity: 10, unitCostZmw: "25.00",
        effectiveAt: "2026-11-19", memo: "Initial physical count", reference: null,
      }),
    });
    const openingPayload = await openingResponse.json() as any;
    assert.equal(openingResponse.status, 201, JSON.stringify(openingPayload));
    const openingMovementId = openingPayload.movement.id as number;

    await db.insert(inventoryReservations).values({
      productId, locationId, quantity: 4, reason: "Reserved for a customer",
    });

    const correctionBody = {
      quantity: 3, unitCostZmw: "25.00", effectiveAt: "2026-11-19",
      reason: "Corrected physical count", reference: null,
    };
    const rejectedResponse = await fetch(`${baseUrl}/api/inventory/opening-stock/${openingMovementId}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(correctionBody),
    });
    const rejectedPayload = await rejectedResponse.json() as any;
    assert.equal(rejectedResponse.status, 409, JSON.stringify(rejectedPayload));
    assert.match(rejectedPayload.error, /below quantities already reserved/i);

    const movementsAfterRejection = await db.select().from(inventoryMovements)
      .where(eq(inventoryMovements.productId, productId));
    assert.deepEqual(movementsAfterRejection.map((movement) => [
      movement.id, movement.kind, movement.quantityDelta,
    ]), [[openingMovementId, "opening_stock", 10]]);
    const journalsAfterRejection = await db.select().from(journalEntries).where(and(
      inArray(journalEntries.sourceType, ["opening_stock", "opening_stock_reversal"]),
      inArray(journalEntries.sourceId, movementsAfterRejection.map((movement) => movement.id)),
    ));
    assert.equal(journalsAfterRejection.length, 1);
    assert.equal(journalsAfterRejection[0]!.sourceId, openingMovementId);

    const acceptedResponse = await fetch(`${baseUrl}/api/inventory/opening-stock/${openingMovementId}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...correctionBody, quantity: 5 }),
    });
    const acceptedPayload = await acceptedResponse.json() as any;
    assert.equal(acceptedResponse.status, 201, JSON.stringify(acceptedPayload));
    const finalMovements = await db.select().from(inventoryMovements)
      .where(eq(inventoryMovements.productId, productId));
    assert.equal(finalMovements.length, 3);
    assert.ok(finalMovements.some((movement) =>
      movement.id === acceptedPayload.reversal.id
        && movement.kind === "opening_stock_reversal"
        && movement.quantityDelta === -10,
    ));
    assert.ok(finalMovements.some((movement) =>
      movement.id === acceptedPayload.movement.id
        && movement.kind === "opening_stock"
        && movement.quantityDelta === 5,
    ));
    const finalJournals = await db.select().from(journalEntries).where(and(
      inArray(journalEntries.sourceType, ["opening_stock", "opening_stock_reversal"]),
      inArray(journalEntries.sourceId, finalMovements.map((movement) => movement.id)),
    ));
    assert.equal(finalJournals.length, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (productId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
        await client.query(`
          DELETE FROM journal_lines
          WHERE journal_entry_id IN (
            SELECT id FROM journal_entries
            WHERE source_id IN (
              SELECT id FROM inventory_movements WHERE product_id = $1
            )
              AND source_type IN ('opening_stock', 'opening_stock_reversal')
          )
        `, [productId]);
        await client.query(`
          DELETE FROM journal_entries
          WHERE source_id IN (
            SELECT id FROM inventory_movements WHERE product_id = $1
          )
            AND source_type IN ('opening_stock', 'opening_stock_reversal')
        `, [productId]);
        await client.query("DELETE FROM inventory_reservations WHERE product_id = $1", [productId]);
        await client.query(
          "UPDATE inventory_movements SET correction_of_movement_id = NULL WHERE product_id = $1",
          [productId],
        );
        await client.query("DELETE FROM inventory_movements WHERE product_id = $1", [productId]);
        await client.query("DELETE FROM products WHERE id = $1", [productId]);
        if (locationId) await client.query("DELETE FROM inventory_locations WHERE id = $1", [locationId]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
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
