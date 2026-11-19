import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { asc, eq, inArray } from "drizzle-orm";
import test from "node:test";
import {
  businessPayments, customers, journalEntries, journalLines, paymentStatementImportBatches,
  paymentStatementLines, salesOrders,
} from "../shared/schema";
import { ensureAccountingAccounts, postJournal } from "./accounting-posting";

test("removing one statement import preserves other lines, matches, and journals", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [
    { db, pool },
    { registerPaymentRoutes },
  ] = await Promise.all([
    import("./db"),
    import("./payment-routes"),
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
  const label = suffix.slice(0, 12);
  const email = `statement-import-removal-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email, role: "owner" };
    next();
  };
  registerPaymentRoutes(app, owner);
  app.use(((error: unknown, _req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  }) as express.ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let customerId: number | undefined;
  const orderIds: number[] = [];
  const paymentIds: number[] = [];
  const journalEntryIds: number[] = [];
  const importBatchIds: number[] = [];
  let statementLineIds: number[] = [];

  const request = async (path: string, method: string, body: unknown, expectedStatus: number) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as any;
    assert.equal(response.status, expectedStatus, JSON.stringify(payload));
    return payload;
  };

  const journalSnapshot = async () => {
    if (!journalEntryIds.length) return { entries: [], lines: [] };
    const entries = await db.select().from(journalEntries)
      .where(inArray(journalEntries.id, journalEntryIds))
      .orderBy(asc(journalEntries.id));
    const lines = await db.select().from(journalLines)
      .where(inArray(journalLines.journalEntryId, journalEntryIds))
      .orderBy(asc(journalLines.id));
    return { entries, lines };
  };

  try {
    const [customer] = await db.insert(customers).values({
      name: `Statement import removal customer ${suffix}`,
    }).returning();
    customerId = customer.id;
    const accountMap = await ensureAccountingAccounts(db);
    const bankAccount = accountMap.get("bank_account");
    assert.ok(bankAccount);

    const paymentFixtures = [
      { reference: `REMOVE-${suffix}`, orderNumber: `SIR-A-${label}`, amount: "125.00" },
      { reference: `KEEP-${suffix}`, orderNumber: `SIR-B-${label}`, amount: "80.00" },
    ];
    for (const [index, fixture] of paymentFixtures.entries()) {
      const [order] = await db.insert(salesOrders).values({
        orderNumber: fixture.orderNumber,
        customerId,
        status: "fulfilled",
        orderDate: "2026-11-10",
      }).returning();
      orderIds.push(order.id);
      const [payment] = await db.insert(businessPayments).values({
        paymentNumber: `PAY-SIR-${label}-${index + 1}`,
        direction: "customer_receipt",
        salesOrderId: order.id,
        amountZmw: fixture.amount,
        paymentDate: "2026-11-10",
        method: "bank_transfer",
        reference: fixture.reference,
      }).returning();
      paymentIds.push(payment.id);
      const entry = await db.transaction((tx) => postJournal(tx, {
        sourceKey: `payment-${payment.id}`,
        sourceType: "payment",
        sourceId: payment.id,
        memo: `Statement import removal payment ${payment.paymentNumber}`,
        entryDate: payment.paymentDate,
        lines: [
          { accountKey: "bank_account", debitZmw: fixture.amount, description: "Payment received" },
          { accountKey: "accounts_receivable", creditZmw: fixture.amount, description: "Customer balance reduced" },
        ],
      }));
      journalEntryIds.push(entry.id);
    }

    const deletedBatch = await request("/api/payments/reconciliation/imports", "POST", {
      accountId: bankAccount.id,
      fileName: `remove-${label}.csv`,
      from: "2026-11-10",
      to: "2026-11-10",
      lines: [
        { transactionDate: "2026-11-10", flow: "in", amountZmw: "125.00", description: "Selected matched row", reference: `REMOVE-${suffix}` },
        { transactionDate: "2026-11-10", flow: "out", amountZmw: "4.00", description: "Selected unmatched row", reference: `REMOVE-EXTRA-${suffix}` },
      ],
      includedIndexes: [0, 1],
      allowDuplicateBatch: false,
    }, 201);
    const selectedBatchId = Number(deletedBatch.batch.id);
    importBatchIds.push(selectedBatchId);
    const preservedBatch = await request("/api/payments/reconciliation/imports", "POST", {
      accountId: bankAccount.id,
      fileName: `keep-${label}.csv`,
      from: "2026-11-10",
      to: "2026-11-10",
      lines: [
        { transactionDate: "2026-11-10", flow: "in", amountZmw: "80.00", description: "Preserved matched row", reference: `KEEP-${suffix}` },
      ],
      includedIndexes: [0],
      allowDuplicateBatch: false,
    }, 201);
    const preservedBatchId = Number(preservedBatch.batch.id);
    importBatchIds.push(preservedBatchId);

    await request("/api/payments/reconciliation/lines", "POST", {
      accountId: bankAccount.id,
      from: "2026-11-10",
      to: "2026-11-10",
      lines: [{
        transactionDate: "2026-11-10",
        flow: "out",
        amountZmw: "3.00",
        description: "Manual statement row",
        reference: `MANUAL-${suffix}`,
      }],
    }, 201);

    const importedRows = await db.select().from(paymentStatementLines)
      .where(inArray(paymentStatementLines.importBatchId, importBatchIds))
      .orderBy(asc(paymentStatementLines.id));
    statementLineIds = importedRows.map((line) => line.id);
    assert.equal(importedRows.length, 3);
    const selectedMatchedLine = importedRows.find((line) =>
      line.importBatchId === selectedBatchId && line.reference === `REMOVE-${suffix}`);
    const preservedMatchedLine = importedRows.find((line) =>
      line.importBatchId === preservedBatchId && line.reference === `KEEP-${suffix}`);
    assert.ok(selectedMatchedLine);
    assert.ok(preservedMatchedLine);

    await request("/api/payments/reconciliation/match", "PUT", {
      lineId: selectedMatchedLine.id, paymentId: paymentIds[0],
    }, 200);
    await request("/api/payments/reconciliation/match", "PUT", {
      lineId: preservedMatchedLine.id, paymentId: paymentIds[1],
    }, 200);
    const [manualLine] = await db.select().from(paymentStatementLines)
      .where(eq(paymentStatementLines.reference, `MANUAL-${suffix}`));
    assert.ok(manualLine);
    statementLineIds.push(manualLine.id);
    assert.equal(manualLine.importBatchId, null);

    const unrelatedLinesBeforeRemoval = await db.select().from(paymentStatementLines)
      .where(inArray(paymentStatementLines.id, [preservedMatchedLine.id, manualLine.id]))
      .orderBy(asc(paymentStatementLines.id));
    const journalsBeforeRemoval = await journalSnapshot();
    await request(`/api/payments/reconciliation/imports/${selectedBatchId}`, "DELETE", {}, 200);
    assert.deepEqual(await journalSnapshot(), journalsBeforeRemoval, "removing an import must not change accounting journals");

    const remainingBatches = await db.select().from(paymentStatementImportBatches)
      .where(inArray(paymentStatementImportBatches.id, importBatchIds))
      .orderBy(asc(paymentStatementImportBatches.id));
    assert.deepEqual(remainingBatches.map((batch) => batch.id), [preservedBatchId]);

    const remainingLines = await db.select().from(paymentStatementLines)
      .where(inArray(paymentStatementLines.id, statementLineIds))
      .orderBy(asc(paymentStatementLines.id));
    assert.deepEqual(
      remainingLines,
      unrelatedLinesBeforeRemoval,
      "the other imported statement row and manual row must remain unchanged",
    );
    assert.deepEqual(remainingLines.map((line) => line.id).sort((a, b) => a - b), [
      preservedMatchedLine.id,
      manualLine.id,
    ].sort((a, b) => a - b));
    assert.equal(remainingLines.find((line) => line.id === preservedMatchedLine.id)?.importBatchId, preservedBatchId);

    const survivingPayments = await db.select().from(businessPayments)
      .where(inArray(businessPayments.id, paymentIds))
      .orderBy(asc(businessPayments.id));
    assert.equal(survivingPayments.length, 2, "deleting a matched statement row must not delete its payment");
    const remainingMatches = await db.select({
      id: paymentStatementLines.id,
      matchedPaymentId: paymentStatementLines.matchedPaymentId,
    }).from(paymentStatementLines)
      .where(inArray(paymentStatementLines.matchedPaymentId, paymentIds));
    assert.deepEqual(remainingMatches, [{
      id: preservedMatchedLine.id,
      matchedPaymentId: paymentIds[1]!,
    }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [email]);
      if (statementLineIds.length) {
        await client.query("DELETE FROM payment_statement_lines WHERE id = ANY($1::int[])", [statementLineIds]);
      }
      if (importBatchIds.length) {
        await client.query("DELETE FROM payment_statement_import_batches WHERE id = ANY($1::int[])", [importBatchIds]);
      }
      if (journalEntryIds.length) {
        await client.query("DELETE FROM journal_lines WHERE journal_entry_id = ANY($1::int[])", [journalEntryIds]);
        await client.query("DELETE FROM journal_entries WHERE id = ANY($1::int[])", [journalEntryIds]);
      }
      if (paymentIds.length) await client.query("DELETE FROM business_payments WHERE id = ANY($1::int[])", [paymentIds]);
      if (orderIds.length) await client.query("DELETE FROM sales_orders WHERE id = ANY($1::int[])", [orderIds]);
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
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
