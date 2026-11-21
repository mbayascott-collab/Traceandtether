import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test, { after } from "node:test";
import { asc, eq, inArray, like, or } from "drizzle-orm";
import {
  businessAuditLogs, businessPayments, customers, journalEntries, journalLines, paymentStatementImportBatches,
  paymentStatementLines, salesOrders,
} from "../shared/schema";
import { ensureAccountingAccounts, postJournal } from "./accounting-posting";

const poolsToClose = new Set<{ end: () => Promise<void> }>();
after(async () => {
  await Promise.all([...poolsToClose].map((pool) => pool.end()));
});

test("adding, matching, and unmatching statement lines never changes journals", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [
    { db, pool },
    { registerPaymentRoutes },
  ] = await Promise.all([
    import("./db"),
    import("./payment-routes"),
  ]);
  poolsToClose.add(pool);

  const suffix = randomUUID();
  const label = suffix.slice(0, 12);
  const email = `payment-reconciliation-${suffix}@example.test`;
  const auditTable = await pool.query(
    "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
  );
  if (!auditTable.rows[0]?.exists) {
    t.skip("requires the business audit database migration");
    return;
  }

  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email, role: "owner" };
    next();
  };
  registerPaymentRoutes(app, owner);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let customerId: number | undefined;
  let orderId: number | undefined;
  let paymentId: number | undefined;
  let journalEntryId: number | undefined;
  let secondPaymentId: number | undefined;
  let secondJournalEntryId: number | undefined;
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
    const journalIds = [journalEntryId, secondJournalEntryId].filter((id): id is number => id !== undefined);
    if (!journalIds.length) return { entries: [], lines: [] };
    const [entries, lines] = await Promise.all([
      db.select().from(journalEntries).where(inArray(journalEntries.id, journalIds)).orderBy(asc(journalEntries.id)),
      db.select().from(journalLines).where(inArray(journalLines.journalEntryId, journalIds)).orderBy(asc(journalLines.id)),
    ]);
    return { entries, lines };
  };
  try {
    const [customer] = await db.insert(customers).values({
      name: `Reconciliation test customer ${suffix}`,
    }).returning();
    customerId = customer.id;
    const [order] = await db.insert(salesOrders).values({
      orderNumber: `RECON-${label}`,
      customerId,
      status: "fulfilled",
      orderDate: "2026-11-10",
    }).returning();
    orderId = order.id;
    const [payment] = await db.insert(businessPayments).values({
      paymentNumber: `PAY-RECON-${label}`,
      direction: "customer_receipt",
      salesOrderId: orderId,
      amountZmw: "125.00",
      paymentDate: "2026-11-10",
      method: "bank_transfer",
      reference: `REF-${suffix}`,
    }).returning();
    paymentId = payment.id;

    const accountMap = await ensureAccountingAccounts(db);
    const bankAccount = accountMap.get("bank_account");
    const receivablesAccount = accountMap.get("accounts_receivable");
    assert.ok(bankAccount && receivablesAccount);
    const entry = await db.transaction((tx) => postJournal(tx, {
      sourceKey: `payment-${paymentId}`,
      sourceType: "payment",
      sourceId: paymentId!,
      memo: `Customer receipt ${payment.paymentNumber}`,
      entryDate: payment.paymentDate,
      lines: [
        { accountKey: "bank_account", debitZmw: "125.00", description: "Payment received" },
        { accountKey: "accounts_receivable", creditZmw: "125.00", description: "Customer balance reduced" },
      ],
    }));
    journalEntryId = entry.id;
    assert.ok(entry);
    const [secondPayment] = await db.insert(businessPayments).values({
      paymentNumber: `PAY-RECON-ALT-${label}`,
      direction: "customer_receipt",
      salesOrderId: orderId,
      amountZmw: "80.00",
      paymentDate: "2026-11-10",
      method: "bank_transfer",
      reference: `ALT-${suffix}`,
    }).returning();
    secondPaymentId = secondPayment.id;
    const secondEntry = await db.transaction((tx) => postJournal(tx, {
      sourceKey: `payment-${secondPaymentId}`,
      sourceType: "payment",
      sourceId: secondPaymentId!,
      memo: `Customer receipt ${secondPayment.paymentNumber}`,
      entryDate: secondPayment.paymentDate,
      lines: [
        { accountKey: "bank_account", debitZmw: "80.00", description: "Payment received" },
        { accountKey: "accounts_receivable", creditZmw: "80.00", description: "Customer balance reduced" },
      ],
    }));
    secondJournalEntryId = secondEntry.id;

    const before = await journalSnapshot();
    const lines = [
      { transactionDate: "2026-11-10", flow: "in", amountZmw: "125.00", reference: `REF-${suffix}` },
      { transactionDate: "2026-11-10", flow: "in", amountZmw: "124.99", reference: `REF-${suffix}` },
      { transactionDate: "2026-11-11", flow: "in", amountZmw: "125.00", reference: `REF-${suffix}` },
      { transactionDate: "2026-11-10", flow: "in", amountZmw: "125.00", reference: `OTHER-${suffix}` },
      { transactionDate: "2026-11-10", flow: "out", amountZmw: "125.00", reference: `REF-${suffix}` },
    ] as const;
    await request("/api/payments/reconciliation/lines", "POST", {
      accountId: bankAccount.id,
      from: "2026-11-10",
      to: "2026-11-11",
      lines: lines.map((line) => ({ ...line, description: "Reconciliation regression test" })),
    }, 201);
    assert.deepEqual(await journalSnapshot(), before, "adding statement lines must not post journals");

    const statementRows = await db.select().from(paymentStatementLines)
      .where(inArray(paymentStatementLines.reference, lines.map((line) => line.reference)))
      .orderBy(asc(paymentStatementLines.id));
    statementLineIds = statementRows.map((line) => line.id);
    assert.equal(statementRows.length, 5);

    for (const statementLine of statementRows) {
      await request("/api/payments/reconciliation/match", "PUT", {
        lineId: statementLine.id, paymentId,
      }, 200);
      assert.deepEqual(await journalSnapshot(), before, "matching a comparison, even with mismatches, must not change journals");

      await request("/api/payments/reconciliation/match", "PUT", {
        lineId: statementLine.id, paymentId: null,
      }, 200);
      assert.deepEqual(await journalSnapshot(), before, "unmatching must not change journals");
    }

    const firstLineId = statementRows[0]!.id;
    const secondLineId = statementRows[1]!.id;
    await request("/api/payments/reconciliation/match", "PUT", {
      lineId: firstLineId, paymentId,
    }, 200);
    assert.deepEqual(await journalSnapshot(), before);
    await request("/api/payments/reconciliation/match", "PUT", {
      lineId: secondLineId, paymentId,
    }, 409);
    assert.deepEqual(await journalSnapshot(), before, "rejecting a duplicate match must not change journals");

    await request("/api/payments/reconciliation/match", "PUT", {
      lineId: firstLineId, paymentId: null,
    }, 200);
    assert.deepEqual(await journalSnapshot(), before, "unmatching before a concurrent attempt must not change journals");

    const concurrentLineIds = [firstLineId, statementRows[2]!.id];
    const concurrentAuditCounts = new Map<number, number>();
    for (const lineId of concurrentLineIds) {
      const auditRows = await db.select().from(businessAuditLogs).where(eq(businessAuditLogs.entityId, lineId));
      concurrentAuditCounts.set(lineId, auditRows.filter((row) =>
        row.entityType === "payment_statement_line" && row.actorEmail === email
          && row.action === "updated" && row.changedFields.includes("matchedPaymentId"),
      ).length);
    }
    const concurrentResponses = await Promise.all(concurrentLineIds.map(async (lineId) => {
      const response = await fetch(`${baseUrl}/api/payments/reconciliation/match`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lineId, paymentId }),
      });
      return { lineId, status: response.status, payload: await response.json() };
    }));
    assert.deepEqual(
      concurrentResponses.map(({ status }) => status).sort(),
      [200, 409],
      JSON.stringify(concurrentResponses),
      "simultaneous attempts to match one payment must accept exactly one request",
    );
    const concurrentLines = await db.select().from(paymentStatementLines)
      .where(inArray(paymentStatementLines.id, concurrentLineIds));
    assert.equal(
      concurrentLines.filter((line) => line.matchedPaymentId === paymentId).length,
      1,
      "one payment must be assigned to exactly one of the concurrent statement rows",
    );
    for (const lineId of concurrentLineIds) {
      const auditRows = await db.select().from(businessAuditLogs).where(eq(businessAuditLogs.entityId, lineId));
      const count = auditRows.filter((row) =>
        row.entityType === "payment_statement_line" && row.actorEmail === email
          && row.action === "updated" && row.changedFields.includes("matchedPaymentId"),
      ).length;
      const accepted = concurrentResponses.some((response) => response.lineId === lineId && response.status === 200);
      assert.equal(count - concurrentAuditCounts.get(lineId)!, accepted ? 1 : 0,
        "a rejected concurrent match must not leave an audit event");
    }
    assert.deepEqual(await journalSnapshot(), before, "concurrent matching must not change journal entries or lines");

    const assignedConcurrentLine = concurrentLines.find((line) => line.matchedPaymentId === paymentId);
    assert.ok(assignedConcurrentLine);
    await request("/api/payments/reconciliation/match", "PUT", {
      lineId: assignedConcurrentLine.id, paymentId: null,
    }, 200);
    const sameLineAuditBefore = (await db.select().from(businessAuditLogs)
      .where(eq(businessAuditLogs.entityId, firstLineId)))
      .filter((row) => row.entityType === "payment_statement_line" && row.actorEmail === email
        && row.action === "updated" && row.changedFields.includes("matchedPaymentId")).length;
    const competingPayments = [paymentId!, secondPaymentId!];
    const sameLineResponses = await Promise.all(competingPayments.map(async (candidatePaymentId) => {
      const response = await fetch(`${baseUrl}/api/payments/reconciliation/match`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lineId: firstLineId, paymentId: candidatePaymentId }),
      });
      return { candidatePaymentId, status: response.status, payload: await response.json() };
    }));
    assert.deepEqual(sameLineResponses.map(({ status }) => status).sort(), [200, 409], JSON.stringify(sameLineResponses));
    const [finalStatementLine] = await db.select().from(paymentStatementLines)
      .where(eq(paymentStatementLines.id, firstLineId));
    assert.equal(finalStatementLine?.matchedPaymentId, sameLineResponses.find(({ status }) => status === 200)?.candidatePaymentId);
    const sameLineAuditAfter = (await db.select().from(businessAuditLogs)
      .where(eq(businessAuditLogs.entityId, firstLineId)))
      .filter((row) => row.entityType === "payment_statement_line" && row.actorEmail === email
        && row.action === "updated" && row.changedFields.includes("matchedPaymentId")).length;
    assert.equal(sameLineAuditAfter - sameLineAuditBefore, 1,
      "only the accepted payment assignment should create an audit event for this statement line");
    assert.deepEqual(await journalSnapshot(), before, "competing matches must not change accounting journals");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [email]);
      if (statementLineIds.length) {
        await client.query("DELETE FROM payment_statement_lines WHERE id = ANY($1::int[])", [statementLineIds]);
      }
      if (journalEntryId) {
        await client.query("DELETE FROM journal_lines WHERE journal_entry_id = $1", [journalEntryId]);
        await client.query("DELETE FROM journal_entries WHERE id = $1", [journalEntryId]);
      }
      if (secondJournalEntryId) {
        await client.query("DELETE FROM journal_lines WHERE journal_entry_id = $1", [secondJournalEntryId]);
        await client.query("DELETE FROM journal_entries WHERE id = $1", [secondJournalEntryId]);
      }
      if (paymentId) await client.query("DELETE FROM business_payments WHERE id = $1", [paymentId]);
      if (secondPaymentId) await client.query("DELETE FROM business_payments WHERE id = $1", [secondPaymentId]);
      if (orderId) await client.query("DELETE FROM sales_orders WHERE id = $1", [orderId]);
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

test("CSV statement imports save review rows without changing journals", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerPaymentRoutes }] = await Promise.all([
    import("./db"),
    import("./payment-routes"),
  ]);
  poolsToClose.add(pool);

  const suffix = randomUUID();
  const label = suffix.slice(0, 12);
  const email = `csv-reconciliation-${suffix}@example.test`;
  const auditTable = await pool.query(
    "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
  );
  if (!auditTable.rows[0]?.exists) {
    t.skip("requires the business audit database migration");
    return;
  }

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
  let importBatchId: number | undefined;
  const csvReferences = [`CSV-${suffix}`, `CSV-UNSELECTED-${suffix}`, `CSV-OUT-${suffix}`];
  const rejectedImportReferences = [`CSV-INVALID-DATE-${suffix}`, `CSV-INVALID-ZERO-${suffix}`];
  const rejectedImportFileNames = [`rejected-date-${label}.csv`, `rejected-zero-${label}.csv`];
  const trackedPaymentReferences = [
    ...csvReferences,
    ...rejectedImportReferences,
    ...rejectedImportReferences.map((reference) => `${reference}-VALID`),
  ];

  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as any;
    return { response, payload };
  };
  const request = async (path: string, body: unknown) => {
    const { response, payload } = await post(path, body);
    assert.equal(response.status, 201, JSON.stringify(payload));
    return payload;
  };
  const journalSnapshot = async () => {
    const entries = await db.select().from(journalEntries).where(or(
      like(journalEntries.sourceKey, `%${label}%`),
      like(journalEntries.memo, `%${label}%`),
    )).orderBy(asc(journalEntries.id));
    const entryIds = entries.map((entry) => entry.id);
    const lines = entryIds.length
      ? await db.select().from(journalLines).where(inArray(journalLines.journalEntryId, entryIds)).orderBy(asc(journalLines.id))
      : [];
    return { entries, lines };
  };
  const paymentSnapshot = async () =>
    db.select({ id: businessPayments.id }).from(businessPayments)
      .where(inArray(businessPayments.reference, trackedPaymentReferences))
      .orderBy(asc(businessPayments.id));

  try {
    const accounts = await ensureAccountingAccounts(db);
    const bankAccount = accounts.get("bank_account");
    assert.ok(bankAccount);
    const before = await journalSnapshot();
    const paymentsBefore = await paymentSnapshot();
    const csvLines = [
      { transactionDate: "2026-11-10", flow: "in", amountZmw: "72.50", description: "CSV review row", reference: `CSV-${suffix}` },
      { transactionDate: "2026-11-11", flow: "in", amountZmw: "14.00", description: "CSV row not selected", reference: `CSV-UNSELECTED-${suffix}` },
      { transactionDate: "2026-11-12", flow: "out", amountZmw: "8.25", description: "CSV review row two", reference: `CSV-OUT-${suffix}` },
    ] as const;
    const selectedLines = [csvLines[0], csvLines[2]];
    const imported = await request("/api/payments/reconciliation/imports", {
      accountId: bankAccount.id,
      fileName: `reconciliation-${label}.csv`,
      from: "2026-11-10",
      to: "2026-11-12",
      lines: csvLines,
      includedIndexes: [0, 2],
      allowDuplicateBatch: false,
    });
    importBatchId = Number(imported.batch.id);
    assert.equal(imported.added, selectedLines.length);
    assert.equal(imported.batch.lineCount, selectedLines.length);
    assert.deepEqual(await journalSnapshot(), before, "CSV import must not create journal entries or journal lines");
    assert.deepEqual(await paymentSnapshot(), paymentsBefore, "CSV import must save review rows, not payment records");

    const importedRows = await db.select().from(paymentStatementLines)
      .where(inArray(paymentStatementLines.reference, csvLines.map((line) => line.reference)))
      .orderBy(asc(paymentStatementLines.id));
    assert.equal(importedRows.length, selectedLines.length);
    assert.equal(importedRows.some((line) => line.reference === csvLines[1].reference), false,
      "unselected references must not appear among saved statement rows");
    assert.deepEqual(importedRows.map((line) => ({
      transactionDate: line.transactionDate,
      flow: line.flow,
      amountZmw: line.amountZmw,
      description: line.description,
      reference: line.reference,
      importBatchId: line.importBatchId,
      matchedPaymentId: line.matchedPaymentId,
    })), selectedLines.map((line) => ({
      ...line,
      importBatchId,
      matchedPaymentId: null,
    })), "CSV rows must be saved as unmatched statement review data");
    const batches = await db.select().from(paymentStatementImportBatches)
      .where(eq(paymentStatementImportBatches.id, importBatchId));
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.fileName, `reconciliation-${label}.csv`);

    const invalidImports = [
      {
        fileName: rejectedImportFileNames[0],
        reference: rejectedImportReferences[0],
        invalidLine: {
          transactionDate: "2026-11-13",
          flow: "in",
          amountZmw: "12.00",
          description: "Outside import date range",
        },
      },
      {
        fileName: rejectedImportFileNames[1],
        reference: rejectedImportReferences[1],
        invalidLine: {
          transactionDate: "2026-11-12",
          flow: "out",
          amountZmw: "0.00",
          description: "Zero amount",
        },
      },
    ] as const;
    for (const invalidImport of invalidImports) {
      const rejected = await post("/api/payments/reconciliation/imports", {
        accountId: bankAccount.id,
        fileName: invalidImport.fileName,
        from: "2026-11-10",
        to: "2026-11-12",
        lines: [
          { transactionDate: "2026-11-10", flow: "in", amountZmw: "4.50", description: "Valid row first", reference: `${invalidImport.reference}-VALID` },
          { ...invalidImport.invalidLine, reference: invalidImport.reference },
        ],
        includedIndexes: [0, 1],
        allowDuplicateBatch: false,
      });
      assert.equal(rejected.response.status, 400, JSON.stringify(rejected.payload));
    }

    const rejectedBatches = await db.select().from(paymentStatementImportBatches)
      .where(inArray(paymentStatementImportBatches.fileName, [...rejectedImportFileNames]));
    const rejectedRows = await db.select().from(paymentStatementLines)
      .where(inArray(paymentStatementLines.reference, [
        ...rejectedImportReferences,
        ...rejectedImportReferences.map((reference) => `${reference}-VALID`),
      ]));
    assert.deepEqual(rejectedBatches, [], "invalid files must not leave import batches");
    assert.deepEqual(rejectedRows, [], "invalid files must not leave any selected statement rows");
    assert.deepEqual(await journalSnapshot(), before, "rejected imports must not change journal entries or lines");
    assert.deepEqual(await paymentSnapshot(), paymentsBefore, "rejected imports must not create payments");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [email]);
      await client.query(
        "DELETE FROM payment_statement_lines WHERE reference = ANY($1::text[])",
        [[...rejectedImportReferences, ...rejectedImportReferences.map((reference) => `${reference}-VALID`)]],
      );
      await client.query(
        "DELETE FROM payment_statement_import_batches WHERE file_name = ANY($1::text[])",
        [rejectedImportFileNames],
      );
      if (importBatchId) {
        await client.query("DELETE FROM payment_statement_import_batches WHERE id = $1", [importBatchId]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});
