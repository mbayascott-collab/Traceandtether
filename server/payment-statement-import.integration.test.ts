import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { asc, eq, inArray } from "drizzle-orm";
import test from "node:test";
import {
  businessAuditLogs, businessPayments, customers, journalEntries, journalLines, paymentStatementImportBatches,
  paymentStatementLines, salesOrders,
} from "../shared/schema";
import { ensureAccountingAccounts, postJournal } from "./accounting-posting";

test("statement import removal preserves unrelated records and concurrent repeats require review", {
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
  let auditFailureTrigger: string | null = null;
  let auditFailureFunction: string | null = null;

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

    const duplicatePreviewLines = [
      {
        transactionDate: "2026-11-10", flow: "in", amountZmw: "125.00",
        description: "Repeated but intentionally selected", reference: `REMOVE-${suffix}`,
      },
      {
        transactionDate: "2026-11-10", flow: "in", amountZmw: "17.00",
        description: "Selected new row", reference: `SUBSET-KEEP-${suffix}`,
      },
      {
        transactionDate: "2026-11-10", flow: "out", amountZmw: "13.00",
        description: "Unselected row", reference: `SUBSET-SKIP-${suffix}`,
      },
    ];
    const duplicatePreview = await request("/api/payments/reconciliation/imports/preview", "POST", {
      accountId: bankAccount.id,
      fileName: `preview-${label}.csv`,
      from: "2026-11-10",
      to: "2026-11-10",
      lines: duplicatePreviewLines,
    }, 200);
    assert.deepEqual(duplicatePreview.duplicateRows, [true, false, false],
      "preview should flag only the row already present on this account");
    const partialBatch = await request("/api/payments/reconciliation/imports", "POST", {
      accountId: bankAccount.id,
      fileName: `partial-${label}.csv`,
      from: "2026-11-10",
      to: "2026-11-10",
      lines: duplicatePreviewLines,
      includedIndexes: [0, 1],
      allowDuplicateBatch: false,
    }, 201);
    const partialBatchId = Number(partialBatch.batch.id);
    importBatchIds.push(partialBatchId);
    assert.equal(partialBatch.added, 2, "the response count must include only selected rows");
    assert.equal(partialBatch.batch.lineCount, 2, "the saved batch count must include only selected rows");
    const partialRows = await db.select().from(paymentStatementLines)
      .where(eq(paymentStatementLines.importBatchId, partialBatchId));
    assert.equal(partialRows.length, 2, "the saved batch must contain only selected rows");
    statementLineIds.push(...partialRows.map((line) => line.id));
    assert.deepEqual(
      partialRows.map((line) => line.reference).sort(),
      [`REMOVE-${suffix}`, `SUBSET-KEEP-${suffix}`].sort(),
      "only selected import rows should be saved, including an intentionally repeated row",
    );
    assert.ok(!partialRows.some((line) => line.reference === `SUBSET-SKIP-${suffix}`));

    const cashAccount = accountMap.get("cash_on_hand");
    assert.ok(cashAccount);
    const crossAccountBatch = await request("/api/payments/reconciliation/imports", "POST", {
      accountId: cashAccount.id,
      fileName: `same-file-other-account-${label}.csv`,
      from: "2026-11-10",
      to: "2026-11-10",
      lines: [
        { transactionDate: "2026-11-10", flow: "in", amountZmw: "125.00", description: "Selected matched row", reference: `REMOVE-${suffix}` },
        { transactionDate: "2026-11-10", flow: "out", amountZmw: "4.00", description: "Selected unmatched row", reference: `REMOVE-EXTRA-${suffix}` },
      ],
      includedIndexes: [0, 1],
      allowDuplicateBatch: false,
    }, 201);
    const crossAccountBatchId = Number(crossAccountBatch.batch.id);
    importBatchIds.push(crossAccountBatchId);
    const crossAccountRows = await db.select().from(paymentStatementLines)
      .where(eq(paymentStatementLines.importBatchId, crossAccountBatchId));
    statementLineIds.push(...crossAccountRows.map((line) => line.id));
    assert.equal(crossAccountRows.length, 2, "identical file contents are separate imports for different accounts");

    const invalidRows = [
      { transactionDate: "2026-11-10", flow: "in", amountZmw: "8.00", description: "Would otherwise save", reference: `INVALID-PARTIAL-${suffix}` },
      { transactionDate: "2026-11-10", flow: "out", amountZmw: "0.00", description: "Zero amount", reference: `INVALID-ZERO-${suffix}` },
    ];
    await request("/api/payments/reconciliation/imports", "POST", {
      accountId: bankAccount.id, fileName: `invalid-zero-${label}.csv`,
      from: "2026-11-10", to: "2026-11-10", lines: invalidRows, includedIndexes: [0],
      allowDuplicateBatch: false,
    }, 400);
    await request("/api/payments/reconciliation/imports", "POST", {
      accountId: bankAccount.id, fileName: `invalid-date-${label}.csv`,
      from: "2026-11-10", to: "2026-11-10",
      lines: [{ transactionDate: "2026-11-11", flow: "in", amountZmw: "8.00", description: "Outside range", reference: `INVALID-DATE-${suffix}` }],
      includedIndexes: [0],
      allowDuplicateBatch: false,
    }, 400);
    assert.equal((await db.select().from(paymentStatementImportBatches)
      .where(inArray(paymentStatementImportBatches.fileName, [`invalid-zero-${label}.csv`, `invalid-date-${label}.csv`]))).length, 0,
    "invalid imports must not leave partial batch records");
    assert.equal((await db.select().from(paymentStatementLines)
      .where(inArray(paymentStatementLines.reference, invalidRows.map((line) => line.reference).concat(`INVALID-DATE-${suffix}`)))).length, 0,
    "invalid imports must not leave statement rows");

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

    const selectedBatchLineIds = importedRows
      .filter((line) => line.importBatchId === selectedBatchId)
      .map((line) => line.id);
    const unrelatedLineIds = statementLineIds.filter((id) => !selectedBatchLineIds.includes(id));
    const unrelatedLinesBeforeRemoval = await db.select().from(paymentStatementLines)
      .where(inArray(paymentStatementLines.id, unrelatedLineIds))
      .orderBy(asc(paymentStatementLines.id));
    const journalsBeforeRemoval = await journalSnapshot();

    const triggerToken = suffix.replaceAll("-", "");
    auditFailureTrigger = `reject_statement_delete_${triggerToken}`;
    auditFailureFunction = `reject_statement_delete_audit_${triggerToken}`;
    await pool.query(`
      CREATE FUNCTION ${auditFailureFunction}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.entity_type = 'payment_statement_import_batch' AND NEW.action = 'deleted' THEN
          RAISE EXCEPTION 'forced audit failure for rollback test';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER ${auditFailureTrigger}
      BEFORE INSERT ON business_audit_logs
      FOR EACH ROW EXECUTE FUNCTION ${auditFailureFunction}()
    `);
    const batchBeforeFailedRemoval = await db.select().from(paymentStatementImportBatches)
      .where(eq(paymentStatementImportBatches.id, selectedBatchId));
    await request(`/api/payments/reconciliation/imports/${selectedBatchId}`, "DELETE", {}, 500);
    assert.equal((await db.select().from(paymentStatementImportBatches)
      .where(eq(paymentStatementImportBatches.id, selectedBatchId))).length, batchBeforeFailedRemoval.length,
    "a failed audit write must keep the import batch intact");
    assert.equal((await db.select().from(paymentStatementLines)
      .where(inArray(paymentStatementLines.id, selectedBatchLineIds))).length, selectedBatchLineIds.length,
    "a failed audit write must keep every imported row intact");
    assert.equal((await db.select().from(businessAuditLogs).where(eq(businessAuditLogs.actorEmail, email)))
      .filter((row) => row.action === "deleted").length, 0,
    "failed deletion must not leave partial deletion audit events");
    await pool.query(`DROP TRIGGER ${auditFailureTrigger} ON business_audit_logs`);
    await pool.query(`DROP FUNCTION ${auditFailureFunction}()`);
    auditFailureTrigger = null;
    auditFailureFunction = null;

    await request(`/api/payments/reconciliation/imports/${selectedBatchId}`, "DELETE", {}, 200);
    assert.deepEqual(await journalSnapshot(), journalsBeforeRemoval, "removing an import must not change accounting journals");

    const remainingBatches = await db.select().from(paymentStatementImportBatches)
      .where(inArray(paymentStatementImportBatches.id, importBatchIds))
      .orderBy(asc(paymentStatementImportBatches.id));
    assert.deepEqual(
      remainingBatches.map((batch) => batch.id),
      [preservedBatchId, partialBatchId, crossAccountBatchId].sort((a, b) => a - b),
    );

    const remainingLines = await db.select().from(paymentStatementLines)
      .where(inArray(paymentStatementLines.id, statementLineIds))
      .orderBy(asc(paymentStatementLines.id));
    assert.deepEqual(
      remainingLines,
      unrelatedLinesBeforeRemoval,
      "the other imported statement row and manual row must remain unchanged",
    );
    assert.equal(remainingLines.find((line) => line.id === preservedMatchedLine.id)?.importBatchId, preservedBatchId);
    const removalAuditRows = (await db.select().from(businessAuditLogs)
      .where(eq(businessAuditLogs.actorEmail, email)))
      .filter((row) => row.action === "deleted");
    assert.deepEqual(
      removalAuditRows
        .filter((row) => row.entityType === "payment_statement_line")
        .map((row) => row.entityId).sort((a, b) => a - b),
      [...selectedBatchLineIds].sort((a, b) => a - b),
      "only the deleted batch's rows should have deletion audit entries",
    );
    assert.deepEqual(
      removalAuditRows.filter((row) => row.entityType === "payment_statement_import_batch").map((row) => row.entityId),
      [selectedBatchId],
    );
    assert.ok(
      removalAuditRows.every((row) => row.actorClerkUserId === `test-${suffix}` && row.actorEmail === email),
      "the deletion audit trail must identify the owner who removed the import",
    );
    const deletedLineIds = removalAuditRows
      .filter((row) => row.entityType === "payment_statement_line")
      .map((row) => row.entityId);
    assert.ok(!deletedLineIds.includes(preservedMatchedLine.id), "the preserved import must not have a deletion audit record");
    assert.ok(!deletedLineIds.includes(manualLine.id), "the manual statement row must not have a deletion audit record");

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

    const concurrentImportBody = {
      accountId: bankAccount.id,
      fileName: `concurrent-${label}.csv`,
      from: "2026-11-18",
      to: "2026-11-18",
      lines: [{
        transactionDate: "2026-11-18",
        flow: "in",
        amountZmw: "31.17",
        description: "Concurrent statement import",
        reference: `CONCURRENT-${suffix}`,
      }],
      includedIndexes: [0],
      allowDuplicateBatch: false,
    };
    const concurrentResponses = await Promise.all([0, 1].map(async () => {
      const response = await fetch(`${baseUrl}/api/payments/reconciliation/imports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(concurrentImportBody),
      });
      return { status: response.status, payload: await response.json() as any };
    }));
    assert.deepEqual(
      concurrentResponses.map(({ status }) => status).sort(),
      [201, 409],
      "simultaneous saves of the same statement must require review for the second request",
    );
    const acceptedConcurrentImport = concurrentResponses.find(({ status }) => status === 201);
    const rejectedConcurrentImport = concurrentResponses.find(({ status }) => status === 409);
    assert.ok(acceptedConcurrentImport);
    assert.ok(rejectedConcurrentImport);
    assert.match(rejectedConcurrentImport.payload.error, /already imported\. Review it before importing again/i);
    assert.equal(
      rejectedConcurrentImport.payload.duplicateBatch.id,
      acceptedConcurrentImport.payload.batch.id,
      "the repeated request must identify the batch created by its concurrent partner",
    );
    const firstConcurrentBatchId = Number(acceptedConcurrentImport.payload.batch.id);
    importBatchIds.push(firstConcurrentBatchId);

    const reviewedRepeat = await request("/api/payments/reconciliation/imports", "POST", {
      ...concurrentImportBody,
      allowDuplicateBatch: true,
    }, 201);
    const reviewedRepeatBatchId = Number(reviewedRepeat.batch.id);
    importBatchIds.push(reviewedRepeatBatchId);
    const concurrentBatches = await db.select().from(paymentStatementImportBatches)
      .where(inArray(paymentStatementImportBatches.id, [firstConcurrentBatchId, reviewedRepeatBatchId]));
    assert.equal(concurrentBatches.length, 2, "an explicitly reviewed repeat should create one additional batch");
    const concurrentLines = await db.select().from(paymentStatementLines)
      .where(inArray(paymentStatementLines.importBatchId, [firstConcurrentBatchId, reviewedRepeatBatchId]));
    assert.equal(concurrentLines.length, 2, "only the accepted and explicitly reviewed imports should save rows");
    statementLineIds.push(...concurrentLines.map((line) => line.id));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (auditFailureTrigger) {
      await pool.query(`DROP TRIGGER IF EXISTS ${auditFailureTrigger} ON business_audit_logs`);
    }
    if (auditFailureFunction) {
      await pool.query(`DROP FUNCTION IF EXISTS ${auditFailureFunction}()`);
    }
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
