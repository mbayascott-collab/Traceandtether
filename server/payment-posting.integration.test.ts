import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import test from "node:test";
import {
  accountingAccounts, businessPayments, customers, importExpenses, journalEntries, journalLines,
  products, purchaseOrderLines, purchaseOrders, salesDeliveries, salesDeliveryLines, salesOrderLines, salesOrders,
  shipments, suppliers,
} from "../shared/schema";
import { cents, journalLinesAreBalanced } from "./accounting-posting";

test("payment routes post both directions to the selected funds account", {
  skip: !process.env.DATABASE_URL || process.env.RUN_PAYMENT_POSTING_INTEGRATION !== "1",
}, async (t) => {
  const [
    { db, pool },
    { registerPaymentRoutes },
    { postJournal },
  ] = await Promise.all([
    import("./db"),
    import("./payment-routes"),
    import("./accounting-posting"),
  ]);

  const auditTable = await pool.query(
    "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
  );
  if (!auditTable.rows[0]?.exists) {
    t.skip("requires the business audit database migration");
    await pool.end();
    return;
  }

  const suffix = randomUUID();
  const actorId = `payment-posting-test-${suffix}`;
  const actorEmail = `${actorId}@example.test`;
  const shortId = suffix.slice(0, 12);
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: actorId, email: actorEmail, role: "owner" };
    next();
  };
  registerPaymentRoutes(app, owner);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let customerId: number | undefined;
  let supplierId: number | undefined;
  let productId: number | undefined;
  let salesOrderId: number | undefined;
  let partiallyDeliveredOrderId: number | undefined;
  let purchaseOrderId: number | undefined;
  let shipmentId: number | undefined;
  let importExpenseId: number | undefined;
  let payableJournalKey: string | undefined;
  const paymentIds: number[] = [];

  const sendPayment = async (body: unknown) => {
    const response = await fetch(`${baseUrl}/api/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as any;
    return { status: response.status, payload };
  };

  const request = async (body: unknown) => {
    const { status, payload } = await sendPayment(body);
    assert.equal(status, 201, JSON.stringify(payload));
    return payload.payment as typeof businessPayments.$inferSelect;
  };

  const paymentJournal = async (paymentId: number) => {
    const [entry] = await db.select().from(journalEntries)
      .where(eq(journalEntries.sourceKey, `payment-${paymentId}`));
    assert.ok(entry, `missing journal for payment ${paymentId}`);
    const lines = await db.select({
      accountKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalLines.journalEntryId, entry.id));
    assert.ok(lines.every((line) => line.accountKey !== null));
    const postingLines = lines.map((line) => ({
      ...line,
      accountKey: line.accountKey ?? "",
    }));
    assert.equal(journalLinesAreBalanced(postingLines), true, `journal for payment ${paymentId} must balance`);
    return { entry, lines: postingLines };
  };

  const assertIdempotentRetry = async (
    body: unknown,
    original: typeof businessPayments.$inferSelect,
  ) => {
    const retry = await sendPayment(body);
    assert.equal(retry.status, 200, JSON.stringify(retry.payload));
    assert.deepEqual(retry.payload.payment, original, "retry must return the original payment");
    assert.equal(
      (await db.select().from(businessPayments)
        .where(eq(businessPayments.idempotencyKey, original.idempotencyKey))).length,
      1,
      "retry must leave exactly one payment record",
    );
    assert.equal(
      (await db.select().from(journalEntries)
        .where(eq(journalEntries.sourceKey, `payment-${original.id}`))).length,
      1,
      "retry must leave exactly one journal",
    );
    await paymentJournal(original.id);
  };

  const paymentRequest = (
    direction: "customer_receipt" | "supplier_payment",
    orderId: number,
    method: "cash" | "bank_transfer" | "mobile_money" | "other",
  ) => ({
    direction,
    idempotencyKey: randomUUID(),
    orderId,
    amountZmw: "1.00",
    paymentDate: "2026-11-18",
    method,
    reference: `POST-${direction}-${method}-${suffix}`,
    notes: null,
  });

  const assertPostedToFundsAccount = async (
    payment: typeof businessPayments.$inferSelect,
    expectedFundsAccount: string,
    direction: "customer_receipt" | "supplier_payment",
  ) => {
    const { lines } = await paymentJournal(payment.id);
    const fundsLine = lines.find((line) => line.accountKey === expectedFundsAccount);
    assert.ok(fundsLine, `${payment.method} must use ${expectedFundsAccount}`);
    assert.equal(
      direction === "customer_receipt" ? fundsLine.debitZmw : fundsLine.creditZmw,
      "1.00",
    );
    assert.deepEqual(lines.map((line) => [
      line.accountKey,
      line.debitZmw,
      line.creditZmw,
    ]).sort(), (direction === "customer_receipt"
      ? [
          [expectedFundsAccount, "1.00", "0.00"],
          ["accounts_receivable", "0.00", "1.00"],
        ]
      : [
          ["accounts_payable", "1.00", "0.00"],
          [expectedFundsAccount, "0.00", "1.00"],
        ]).sort());
    assert.equal(lines.reduce((total, line) => total + cents(line.debitZmw), 0n), 100n);
  };

  try {
    const [customer] = await db.insert(customers).values({
      name: `Payment posting customer ${suffix}`,
    }).returning();
    customerId = customer.id;
    const [supplier] = await db.insert(suppliers).values({
      name: `Payment posting supplier ${suffix}`,
    }).returning();
    supplierId = supplier.id;
    const [product] = await db.insert(products).values({
      sku: `PAY-${suffix}`,
      name: `Payment posting product ${suffix}`,
      status: "active",
    }).returning();
    productId = product.id;

    const [salesOrder] = await db.insert(salesOrders).values({
      orderNumber: `PAY-C-${shortId}`,
      customerId,
      status: "fulfilled",
      orderDate: "2026-11-18",
    }).returning();
    salesOrderId = salesOrder.id;
    await db.insert(salesOrderLines).values({
      salesOrderId,
      productId,
      quantity: 1,
      unitPriceZmw: "100.00",
    });
    const [partiallyDeliveredOrder] = await db.insert(salesOrders).values({
      orderNumber: `PAY-PARTIAL-${shortId}`,
      customerId,
      status: "partially_fulfilled",
      orderDate: "2026-11-18",
    }).returning();
    partiallyDeliveredOrderId = partiallyDeliveredOrder.id;
    const [partiallyDeliveredLine] = await db.insert(salesOrderLines).values({
      salesOrderId: partiallyDeliveredOrderId,
      productId,
      quantity: 10,
      unitPriceZmw: "100.00",
    }).returning();
    const [partialDelivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `PAY-PARTIAL-D-${shortId}`,
      idempotencyKey: `pay-partial-delivery-${suffix}`,
      salesOrderId: partiallyDeliveredOrderId,
      deliveryDate: "2026-11-18",
    }).returning();
    await db.insert(salesDeliveryLines).values({
      deliveryId: partialDelivery.id,
      salesOrderLineId: partiallyDeliveredLine.id,
      quantity: 4,
    });

    const [purchaseOrder] = await db.insert(purchaseOrders).values({
      orderNumber: `PAY-S-${shortId}`,
      supplierId,
      currency: "ZMW",
      exchangeRateToZmw: "1",
      orderedAt: "2026-11-18",
    }).returning();
    purchaseOrderId = purchaseOrder.id;
    await db.insert(purchaseOrderLines).values({
      purchaseOrderId,
      productId,
      quantityOrdered: 1,
      unitPrice: "100.00",
    });
    payableJournalKey = `payment-posting-payable-${suffix}`;
    await db.transaction((tx) => postJournal(tx, {
      sourceKey: payableJournalKey!,
      sourceType: "stock_receipt",
      sourceId: purchaseOrderId!,
      memo: `Stock receipt for ${purchaseOrder.orderNumber}`,
      entryDate: "2026-11-18",
      lines: [
        { accountKey: "inventory", productId, debitZmw: "100.00" },
        { accountKey: "accounts_payable", creditZmw: "100.00" },
      ],
    }));
    const [sharedShipment] = await db.insert(shipments).values({
      purchaseOrderId,
      shipmentReference: `PAY-SH-${shortId}`,
      status: "received",
      receivedAt: "2026-11-18",
    }).returning();
    shipmentId = sharedShipment.id;
    const [sharedExpense] = await db.insert(importExpenses).values({
      shipmentId,
      category: "Freight",
      description: `Shared shipment bill ${suffix}`,
      amount: "10.00",
      currency: "ZMW",
      exchangeRateToZmw: "1",
      basis: "value",
      incurredAt: "2026-11-18",
    }).returning();
    importExpenseId = sharedExpense.id;

    const sharedBillPaymentRequest = {
      direction: "supplier_payment" as const,
      idempotencyKey: randomUUID(),
      orderId: null,
      importExpenseId,
      amountZmw: "1.00",
      paymentDate: "2026-11-18",
      method: "bank_transfer" as const,
      reference: null,
      notes: null,
    };
    const sharedBillPayment = await request(sharedBillPaymentRequest);
    paymentIds.push(sharedBillPayment.id);
    await assertIdempotentRetry(sharedBillPaymentRequest, sharedBillPayment);
    await assertPostedToFundsAccount(sharedBillPayment, "bank_account", "supplier_payment");
    const changedPaymentRetry = await sendPayment({
      ...sharedBillPaymentRequest,
      amountZmw: "2.00",
    });
    assert.equal(changedPaymentRetry.status, 409);
    assert.match(changedPaymentRetry.payload.error, /used for different payment details/i);
    const [unchangedSharedBillPayment] = await db.select().from(businessPayments)
      .where(eq(businessPayments.id, sharedBillPayment.id));
    assert.deepEqual({
      ...unchangedSharedBillPayment,
      createdAt: unchangedSharedBillPayment!.createdAt.toISOString(),
    }, sharedBillPayment);
    assert.equal(
      (await db.select().from(journalEntries).where(eq(journalEntries.sourceKey, `payment-${sharedBillPayment.id}`))).length,
      1,
    );

    const competingBillPayments = [1, 2].map(() => ({
      ...sharedBillPaymentRequest,
      idempotencyKey: randomUUID(),
      amountZmw: "6.00",
      reference: null,
    }));
    const competingResults = await Promise.all(competingBillPayments.map(sendPayment));
    assert.deepEqual(competingResults.map((result) => result.status).sort(), [201, 400]);
    const winningBillPayment = competingResults.find((result) => result.status === 201)!.payload.payment;
    paymentIds.push(winningBillPayment.id);
    const losingBillPayment = competingResults.find((result) => result.status === 400)!;
    assert.match(losingBillPayment.payload.error, /outstanding balance/i);
    const shipmentBillPayments = await db.select().from(businessPayments)
      .where(eq(businessPayments.importExpenseId, importExpenseId));
    assert.equal(shipmentBillPayments.length, 2);
    assert.equal(
      shipmentBillPayments.reduce((total, payment) => total + cents(payment.amountZmw), 0n),
      700n,
      "the shared bill balance must not be overpaid by concurrent requests",
    );
    await paymentJournal(winningBillPayment.id);

    // Keep a pre-existing payment and its journal as a sentinel while other
    // methods are posted through the same route.
    const priorCustomerRequest = paymentRequest("customer_receipt", salesOrderId, "cash");
    const priorCustomerPayment = await request(priorCustomerRequest);
    paymentIds.push(priorCustomerPayment.id);
    await assertIdempotentRetry(priorCustomerRequest, priorCustomerPayment);
    const priorCustomerPaymentSnapshot = {
      payment: (await db.select().from(businessPayments)
        .where(eq(businessPayments.id, priorCustomerPayment.id)))[0],
      journal: await paymentJournal(priorCustomerPayment.id),
    };
    await assertPostedToFundsAccount(priorCustomerPayment, "cash_on_hand", "customer_receipt");

    const priorSupplierRequest = paymentRequest("supplier_payment", purchaseOrderId, "bank_transfer");
    const priorSupplierPayment = await request(priorSupplierRequest);
    paymentIds.push(priorSupplierPayment.id);
    await assertIdempotentRetry(priorSupplierRequest, priorSupplierPayment);
    const priorSupplierPaymentSnapshot = {
      payment: (await db.select().from(businessPayments)
        .where(eq(businessPayments.id, priorSupplierPayment.id)))[0],
      journal: await paymentJournal(priorSupplierPayment.id),
    };
    await assertPostedToFundsAccount(priorSupplierPayment, "bank_account", "supplier_payment");

    const methods = [
      ["cash", "cash_on_hand"],
      ["bank_transfer", "bank_account"],
      ["mobile_money", "mobile_money"],
      ["other", "other_funds"],
    ] as const;
    for (const [method, fundsAccount] of methods) {
      const customerPayment = method === "cash"
        ? priorCustomerPayment
        : await request(paymentRequest("customer_receipt", salesOrderId, method));
      if (customerPayment.id !== priorCustomerPayment.id) paymentIds.push(customerPayment.id);
      await assertPostedToFundsAccount(customerPayment, fundsAccount, "customer_receipt");

      const supplierPayment = method === "bank_transfer"
        ? priorSupplierPayment
        : await request(paymentRequest("supplier_payment", purchaseOrderId, method));
      if (supplierPayment.id !== priorSupplierPayment.id) paymentIds.push(supplierPayment.id);
      await assertPostedToFundsAccount(supplierPayment, fundsAccount, "supplier_payment");
    }

    for (const [direction, orderId] of [
      ["customer_receipt", salesOrderId],
      ["supplier_payment", purchaseOrderId],
    ] as const) {
      const attempts = [
        paymentRequest(direction, orderId, "cash"),
        paymentRequest(direction, orderId, "cash"),
      ].map((body, index) => ({
        ...body, amountZmw: "60.00", reference: `CONCURRENT-${direction}-${index}-${suffix}`,
      }));
      const results = await Promise.all(attempts.map((body) => sendPayment(body)));
      assert.deepEqual(
        results.map(({ status }) => status).sort(),
        [201, 400],
        `only one concurrent ${direction} may use the remaining balance`,
      );

      const savedAttempts = await db.select().from(businessPayments)
        .where(eq(
          direction === "customer_receipt" ? businessPayments.salesOrderId : businessPayments.purchaseOrderId,
          orderId,
        ));
      const savedConcurrent = savedAttempts.filter((payment) =>
        attempts.some((attempt) => attempt.idempotencyKey === payment.idempotencyKey));
      assert.equal(savedConcurrent.length, 1, `only the accepted ${direction} should persist`);
      assert.equal(savedConcurrent[0].amountZmw, "60.00");
      paymentIds.push(savedConcurrent[0].id);

      const rejectedAttempt = attempts.find((attempt) =>
        results.find((result) => result.payload.payment?.idempotencyKey === attempt.idempotencyKey) === undefined);
      assert.ok(rejectedAttempt, `one concurrent ${direction} should be rejected`);
      assert.equal(
        (await db.select().from(businessPayments)
          .where(eq(businessPayments.idempotencyKey, rejectedAttempt.idempotencyKey))).length,
        0,
        `rejected ${direction} must not persist a payment`,
      );
      assert.equal(
        (await db.select().from(journalEntries)
          .where(eq(journalEntries.sourceKey, `payment-${savedConcurrent[0].id}`))).length,
        1,
        `accepted ${direction} must create exactly one journal`,
      );
      const { lines } = await paymentJournal(savedConcurrent[0].id);
      assert.equal(lines.reduce((total, line) => total + cents(line.debitZmw), 0n), 6_000n);
    }

    const partialAttempts = [
      paymentRequest("customer_receipt", partiallyDeliveredOrderId!, "cash"),
      paymentRequest("customer_receipt", partiallyDeliveredOrderId!, "cash"),
    ].map((body, index) => ({
      ...body,
      amountZmw: "250.00",
      reference: `PARTIAL-CONCURRENT-${index}-${suffix}`,
    }));
    const partialResults = await Promise.all(partialAttempts.map((body) => sendPayment(body)));
    assert.deepEqual(partialResults.map(({ status }) => status).sort(), [201, 400]);
    const partialAccepted = partialResults.find(({ status }) => status === 201);
    const partialRejected = partialResults.find(({ status }) => status === 400);
    assert.ok(partialAccepted);
    assert.match(partialRejected?.payload.error ?? "", /outstanding balance of ZMW 150\.00/i);
    const savedPartialPayments = await db.select().from(businessPayments)
      .where(eq(businessPayments.salesOrderId, partiallyDeliveredOrderId!));
    const acceptedPartialPayment = savedPartialPayments.find((payment) =>
      partialAttempts.some((attempt) => attempt.idempotencyKey === payment.idempotencyKey));
    const rejectedPartialAttempt = partialAttempts.find((attempt) =>
      attempt.idempotencyKey !== acceptedPartialPayment?.idempotencyKey);
    assert.ok(acceptedPartialPayment);
    assert.ok(rejectedPartialAttempt);
    assert.equal(savedPartialPayments.filter((payment) =>
      partialAttempts.some((attempt) => attempt.idempotencyKey === payment.idempotencyKey)).length, 1);
    assert.equal((await db.select().from(businessPayments)
      .where(eq(businessPayments.idempotencyKey, rejectedPartialAttempt.idempotencyKey))).length, 0);
    assert.equal((await db.select().from(journalEntries)
      .where(eq(journalEntries.sourceKey, `payment-${acceptedPartialPayment.id}`))).length, 1);

    assert.deepEqual(
      (await db.select().from(businessPayments).where(eq(businessPayments.id, priorCustomerPayment.id)))[0],
      priorCustomerPaymentSnapshot.payment,
      "later payments must not alter an existing customer payment record",
    );
    assert.deepEqual(
      await paymentJournal(priorCustomerPayment.id),
      priorCustomerPaymentSnapshot.journal,
      "later payments must not alter an existing customer journal",
    );
    assert.deepEqual(
      (await db.select().from(businessPayments).where(eq(businessPayments.id, priorSupplierPayment.id)))[0],
      priorSupplierPaymentSnapshot.payment,
      "later payments must not alter an existing supplier payment record",
    );
    assert.deepEqual(
      await paymentJournal(priorSupplierPayment.id),
      priorSupplierPaymentSnapshot.journal,
      "later payments must not alter an existing supplier journal",
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      const fixturePayments = await client.query<{ id: number }>(
        "SELECT id FROM business_payments WHERE sales_order_id = ANY($1::int[]) OR purchase_order_id = $2 OR import_expense_id = $3",
        [
          [salesOrderId, partiallyDeliveredOrderId].filter((id): id is number => id !== undefined),
          purchaseOrderId ?? null,
          importExpenseId ?? null,
        ],
      );
      for (const payment of fixturePayments.rows) paymentIds.push(payment.id);
      const journalSourceKeys = [
        ...[...new Set(paymentIds)].map((id) => `payment-${id}`),
        ...(payableJournalKey ? [payableJournalKey] : []),
      ];
      if (journalSourceKeys.length) {
        await client.query(
          "DELETE FROM journal_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE source_key = ANY($1::text[]))",
          [journalSourceKeys],
        );
        await client.query("DELETE FROM journal_entries WHERE source_key = ANY($1::text[])", [journalSourceKeys]);
      }
      if (paymentIds.length) {
        await client.query("DELETE FROM business_payments WHERE id = ANY($1::int[])", [[...new Set(paymentIds)]]);
      }
      if (salesOrderId) {
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [salesOrderId]);
        await client.query("DELETE FROM sales_orders WHERE id = $1", [salesOrderId]);
      }
      if (partiallyDeliveredOrderId) {
        await client.query(
          "DELETE FROM sales_delivery_lines WHERE delivery_id IN (SELECT id FROM sales_deliveries WHERE sales_order_id = $1)",
          [partiallyDeliveredOrderId],
        );
        await client.query("DELETE FROM sales_deliveries WHERE sales_order_id = $1", [partiallyDeliveredOrderId]);
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [partiallyDeliveredOrderId]);
        await client.query("DELETE FROM sales_orders WHERE id = $1", [partiallyDeliveredOrderId]);
      }
      if (importExpenseId) await client.query("DELETE FROM import_expenses WHERE id = $1", [importExpenseId]);
      if (shipmentId) await client.query("DELETE FROM shipments WHERE id = $1", [shipmentId]);
      if (purchaseOrderId) {
        await client.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1", [purchaseOrderId]);
        await client.query("DELETE FROM purchase_orders WHERE id = $1", [purchaseOrderId]);
      }
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
      if (supplierId) await client.query("DELETE FROM suppliers WHERE id = $1", [supplierId]);
      if (productId) await client.query("DELETE FROM products WHERE id = $1", [productId]);
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
