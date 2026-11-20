import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { and, eq, inArray, like, or } from "drizzle-orm";
import test from "node:test";
import {
  accountingAccounts, accountingCorrections, businessAuditLogs, businessExpenses, journalEntries, journalLines,
  ownerFundTransactions,
} from "../shared/schema";
import { cashAccountKeyForMethod, operatingExpenseAccountKey } from "./accounting-posting";

test("managers are forbidden from accounting corrections and journal details", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const { registerAccountingRoutes } = await import("./accounting-routes");
  const app = express();
  app.use(express.json());
  const manager: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: "correction-auth-manager", email: "manager@example.test", role: "manager" };
    next();
  };
  registerAccountingRoutes(app, manager);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  try {
    const [expenseResponse, fundResponse, journalResponse] = await Promise.all([
      request("/api/accounting/expenses/2147483647/correct", {
        category: "rent",
        description: "Unauthorized expense correction",
        amountZmw: "12.00",
        expenseDate: "2002-02-10",
        method: "cash",
        reason: "Managers cannot correct expenses",
      }),
      request("/api/accounting/funds/2147483647/correct", {
        kind: "business_loan",
        amountZmw: "27.00",
        receivedAt: "2002-02-12",
        method: "cash",
        reason: "Managers cannot correct owner funds",
      }),
      fetch(`${baseUrl}/api/accounting/journal-entries/1`),
    ]);
    assert.equal(expenseResponse.status, 403);
    assert.equal(fundResponse.status, 403);
    assert.equal(journalResponse.status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("expense and owner-fund corrections preserve originals and post linked balanced journals", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerAccountingRoutes }] = await Promise.all([
    import("./db"),
    import("./accounting-routes"),
  ]);
  const migration = await pool.query<{ column_name: string | null }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'owner_fund_transactions' AND column_name = 'idempotency_key'",
  );
  const correctionIdempotencyMigration = await pool.query<{ column_name: string | null }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounting_corrections' AND column_name = 'idempotency_key'",
  );
  if (!migration.rows.length || !correctionIdempotencyMigration.rows.length) {
    await pool.end();
    t.skip("requires the owner-fund and accounting-correction idempotency migrations");
    return;
  }
  const suffix = randomUUID();
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (req, res, next) => {
    const role = req.header("x-test-role") === "manager" ? "manager" : "owner";
    res.locals.actor = { clerkUserId: `correction-test-${suffix}-${role}`, email: `${suffix}@example.test`, role };
    next();
  };
  registerAccountingRoutes(app, owner);
  app.use(((error: unknown, _req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  }) as express.ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let expenseId: number | null = null;
  let fundId: number | null = null;
  let correctionFailureTrigger: string | null = null;
  let correctionFailureFunction: string | null = null;
  const request = async (path: string, body?: unknown, role?: "manager") => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : {
        "content-type": "application/json",
        ...(role ? { "x-test-role": role } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, payload: await response.json() as any };
  };

  try {
    const expenseResult = await request("/api/accounting/expenses", {
      category: "other",
      description: `Correction test expense ${suffix}`,
      amountZmw: "10.00",
      expenseDate: "2002-01-10",
      method: "cash",
      reference: `expense-${suffix}`,
      notes: "Original expense",
    });
    assert.equal(expenseResult.response.status, 201, JSON.stringify(expenseResult.payload));
    const createdExpenseId = Number(expenseResult.payload.expense.id);
    expenseId = createdExpenseId;
    const [originalExpenseRecord] = await db.select().from(businessExpenses)
      .where(eq(businessExpenses.id, createdExpenseId));
    const [originalExpenseJournal] = await db.select().from(journalEntries)
      .where(eq(journalEntries.sourceKey, `business-expense-${createdExpenseId}`));
    assert.ok(originalExpenseRecord);
    assert.ok(originalExpenseJournal);
    const originalExpenseJournalLines = await db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, originalExpenseJournal.id))
      .orderBy(journalLines.id);

    const fundResult = await request("/api/accounting/funds", {
      idempotencyKey: randomUUID(),
      kind: "owner_contribution",
      amountZmw: "25.00",
      receivedAt: "2002-01-12",
      method: "cash",
      reference: `fund-${suffix}`,
      notes: "Original owner funds",
    });
    assert.equal(fundResult.response.status, 201, JSON.stringify(fundResult.payload));
    const createdFundId = Number(fundResult.payload.transaction.id);
    fundId = createdFundId;

    const deniedCorrections = await Promise.all([
      request(`/api/accounting/expenses/${createdExpenseId}/correct`, {
        category: "rent",
        description: `Denied expense correction ${suffix}`,
        amountZmw: "12.00",
        expenseDate: "2002-02-10",
        method: "cash",
        reference: `denied-expense-${suffix}`,
        reason: `Manager must not correct expense ${suffix}`,
      }, "manager"),
      request(`/api/accounting/funds/${createdFundId}/correct`, {
        kind: "business_loan",
        amountZmw: "27.00",
        receivedAt: "2002-02-12",
        method: "cash",
        reference: `denied-fund-${suffix}`,
        reason: `Manager must not correct owner funds ${suffix}`,
      }, "manager"),
    ]);
    for (const denied of deniedCorrections) {
      assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    }
    const deniedRecordCorrections = await db.select().from(accountingCorrections).where(or(
      and(
        eq(accountingCorrections.recordType, "business_expense"),
        eq(accountingCorrections.recordId, createdExpenseId),
      ),
      and(
        eq(accountingCorrections.recordType, "owner_fund_transaction"),
        eq(accountingCorrections.recordId, createdFundId),
      ),
    ));
    assert.equal(deniedRecordCorrections.length, 0, "denied requests must not create correction records");
    const deniedCorrectionJournals = await db.select().from(journalEntries).where(and(
      inArray(journalEntries.sourceType, ["accounting_correction", "accounting_correction_reversal"]),
      like(journalEntries.memo, `%${suffix}%`),
    ));
    assert.equal(deniedCorrectionJournals.length, 0, "denied requests must not create correction journals");

    const januaryBeforeCorrection = await request("/api/accounting?from=2002-01-01&to=2002-01-31");
    const yearBeforeCorrection = await request("/api/accounting?from=2002-01-01&to=2002-12-31");
    assert.equal(januaryBeforeCorrection.response.status, 200, JSON.stringify(januaryBeforeCorrection.payload));
    assert.equal(yearBeforeCorrection.response.status, 200, JSON.stringify(yearBeforeCorrection.payload));
    assert.ok(
      januaryBeforeCorrection.payload.expenses.some((row: any) => row.id === createdExpenseId),
      "the original expense must appear in its original reporting period before correction",
    );
    const firstExpenseCorrectionKey = randomUUID();
    const firstExpenseCorrection = {
      category: "rent",
      description: `Corrected expense ${suffix}`,
      amountZmw: "15.75",
      expenseDate: "2002-03-10",
      method: "bank_transfer",
      reference: `corrected-expense-${suffix}`,
      notes: "Corrected expense note",
      reason: `Wrong account and amount ${suffix}`,
      idempotencyKey: firstExpenseCorrectionKey,
    };
    const firstFundCorrectionKey = randomUUID();
    const firstFundCorrection = {
      kind: "business_loan",
      amountZmw: "30.00",
      receivedAt: "2002-03-12",
      method: "bank_transfer",
      reference: `corrected-fund-${suffix}`,
      notes: "Corrected loan",
      reason: "It was a loan, not a contribution",
      idempotencyKey: firstFundCorrectionKey,
    };
    const triggerToken = suffix.replaceAll("-", "");
    correctionFailureTrigger = `fail_correction_replacement_${triggerToken}`;
    correctionFailureFunction = `fail_correction_replacement_fn_${triggerToken}`;
    await pool.query(`
      CREATE FUNCTION ${correctionFailureFunction}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source_type = 'accounting_correction'
          AND NEW.memo LIKE '%${suffix}%'
        THEN
          RAISE EXCEPTION 'forced correction replacement failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER ${correctionFailureTrigger}
      BEFORE INSERT ON journal_entries
      FOR EACH ROW EXECUTE FUNCTION ${correctionFailureFunction}()
    `);
    const failedCorrection = await request(
      `/api/accounting/expenses/${createdExpenseId}/correct`, firstExpenseCorrection,
    );
    assert.equal(failedCorrection.response.status, 500, JSON.stringify(failedCorrection.payload));
    assert.equal((await db.select().from(accountingCorrections).where(and(
      eq(accountingCorrections.recordType, "business_expense"),
      eq(accountingCorrections.recordId, createdExpenseId),
    ))).length, 0, "a failed replacement must roll back its correction row");
    assert.equal((await db.select().from(businessAuditLogs)
      .where(eq(businessAuditLogs.actorEmail, `${suffix}@example.test`)))
      .filter((row) => row.entityType === "accounting_correction").length, 0,
    "a failed replacement must not leave an audit record");
    assert.equal((await db.select().from(journalEntries).where(and(
      inArray(journalEntries.sourceType, ["accounting_correction", "accounting_correction_reversal"]),
      like(journalEntries.memo, `%${suffix}%`),
    ))).length, 0, "a failed replacement must roll back both correction journals");
    const [expenseAfterFailure] = await db.select().from(businessExpenses)
      .where(eq(businessExpenses.id, createdExpenseId));
    assert.deepEqual(expenseAfterFailure, originalExpenseRecord);
    const expenseJournalLinesAfterFailure = await db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, originalExpenseJournal.id))
      .orderBy(journalLines.id);
    assert.deepEqual(expenseJournalLinesAfterFailure, originalExpenseJournalLines);
    await pool.query(`DROP TRIGGER ${correctionFailureTrigger} ON journal_entries`);
    await pool.query(`DROP FUNCTION ${correctionFailureFunction}()`);
    correctionFailureTrigger = null;
    correctionFailureFunction = null;

    const duplicateSubmissions = await Promise.all([
      request(`/api/accounting/expenses/${createdExpenseId}/correct`, firstExpenseCorrection),
      request(`/api/accounting/expenses/${createdExpenseId}/correct`, firstExpenseCorrection),
      request(`/api/accounting/expenses/${createdExpenseId}/correct`, firstExpenseCorrection),
      request(`/api/accounting/funds/${createdFundId}/correct`, firstFundCorrection),
      request(`/api/accounting/funds/${createdFundId}/correct`, firstFundCorrection),
      request(`/api/accounting/funds/${createdFundId}/correct`, firstFundCorrection),
    ]);
    for (const { response, payload } of duplicateSubmissions) {
      assert.ok([200, 201].includes(response.status), JSON.stringify(payload));
    }
    for (const recordType of ["business_expense", "owner_fund_transaction"]) {
      const recordSubmissions = duplicateSubmissions.filter((submission) =>
        submission.payload.correction?.recordType === recordType);
      assert.equal(recordSubmissions.length, 3);
      assert.equal(recordSubmissions.filter(({ response }) => response.status === 201).length, 1);
      assert.equal(recordSubmissions.filter(({ response }) => response.status === 200).length, 2);
      assert.equal(new Set(recordSubmissions.map(({ payload }) => payload.correction.id)).size, 1);
      assert.ok(recordSubmissions.every(({ payload }) =>
        payload.correction.reversalEntryId && payload.correction.replacementEntryId));
    }
    const repeatedExpense = await request(
      `/api/accounting/expenses/${createdExpenseId}/correct`, firstExpenseCorrection,
    );
    const repeatedFund = await request(`/api/accounting/funds/${createdFundId}/correct`, firstFundCorrection);
    assert.equal(repeatedExpense.response.status, 200);
    assert.equal(repeatedFund.response.status, 200);
    assert.equal(repeatedExpense.payload.correction.id, duplicateSubmissions[0].payload.correction.id);
    assert.equal(repeatedFund.payload.correction.id, duplicateSubmissions[3].payload.correction.id);
    const conflictingRetries = await Promise.all([
      request(`/api/accounting/expenses/${createdExpenseId}/correct`, {
        ...firstExpenseCorrection,
        amountZmw: "16.00",
      }),
      request(`/api/accounting/funds/${createdFundId}/correct`, {
        ...firstFundCorrection,
        amountZmw: "31.00",
      }),
    ]);
    for (const conflict of conflictingRetries) {
      assert.equal(conflict.response.status, 409, JSON.stringify(conflict.payload));
    }

    const laterCorrections = await Promise.all([
      request(`/api/accounting/expenses/${createdExpenseId}/correct`, {
        category: "utilities",
        description: `Final expense version one ${suffix}`,
        amountZmw: "18.25",
        expenseDate: "2002-03-10",
        method: "mobile_money",
        reference: `final-expense-one-${suffix}`,
        notes: "First later correction",
        reason: "Corrected date and amount, version one",
        idempotencyKey: randomUUID(),
      }),
      request(`/api/accounting/expenses/${createdExpenseId}/correct`, {
        category: "rent",
        description: `Final expense version two ${suffix}`,
        amountZmw: "19.40",
        expenseDate: "2002-03-10",
        method: "bank_transfer",
        reference: `final-expense-two-${suffix}`,
        notes: "Second later correction",
        reason: "Corrected date and amount, version two",
        idempotencyKey: randomUUID(),
      }),
      request(`/api/accounting/expenses/${createdExpenseId}/correct`, {
        category: "utilities",
        description: `Final expense version three ${suffix}`,
        amountZmw: "21.10",
        expenseDate: "2002-03-10",
        method: "cash",
        reference: `final-expense-three-${suffix}`,
        notes: "Third later correction",
        reason: "Corrected date and amount, version three",
        idempotencyKey: randomUUID(),
      }),
      request(`/api/accounting/funds/${createdFundId}/correct`, {
        kind: "owner_withdrawal",
        amountZmw: "32.50",
        receivedAt: "2002-03-12",
        method: "mobile_money",
        reference: `final-fund-one-${suffix}`,
        notes: "First corrected withdrawal",
        reason: "Corrected the transaction classification, version one",
        idempotencyKey: randomUUID(),
      }),
      request(`/api/accounting/funds/${createdFundId}/correct`, {
        kind: "business_loan",
        amountZmw: "35.75",
        receivedAt: "2002-03-12",
        method: "bank_transfer",
        reference: `final-fund-two-${suffix}`,
        notes: "Second corrected loan",
        reason: "Corrected the transaction classification, version two",
        idempotencyKey: randomUUID(),
      }),
      request(`/api/accounting/funds/${createdFundId}/correct`, {
        kind: "owner_contribution",
        amountZmw: "36.25",
        receivedAt: "2002-03-12",
        method: "cash",
        reference: `final-fund-three-${suffix}`,
        notes: "Third corrected contribution",
        reason: "Corrected the transaction classification, version three",
        idempotencyKey: randomUUID(),
      }),
    ]);
    for (const correction of laterCorrections) {
      assert.equal(correction.response.status, 201, JSON.stringify(correction.payload));
    }

    const [originalExpense] = await db.select().from(businessExpenses).where(eq(businessExpenses.id, createdExpenseId));
    assert.deepEqual(
      originalExpense,
      originalExpenseRecord,
      "correcting an expense must leave its original record unchanged",
    );
    const [preservedOriginalExpenseJournal] = await db.select().from(journalEntries)
      .where(eq(journalEntries.id, originalExpenseJournal.id));
    assert.deepEqual(preservedOriginalExpenseJournal, originalExpenseJournal);
    const preservedOriginalExpenseJournalLines = await db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, originalExpenseJournal.id))
      .orderBy(journalLines.id);
    assert.deepEqual(
      preservedOriginalExpenseJournalLines,
      originalExpenseJournalLines,
      "correcting an expense must leave its original journal lines unchanged",
    );
    const [originalFund] = await db.select().from(ownerFundTransactions).where(eq(ownerFundTransactions.id, createdFundId));
    assert.equal(originalFund.amountZmw, "25.00");
    assert.equal(originalFund.kind, "owner_contribution");
    assert.equal(originalFund.transactionDate, "2002-01-12");

    const januaryReport = await request("/api/accounting?from=2002-01-01&to=2002-01-31");
    assert.equal(januaryReport.response.status, 200, JSON.stringify(januaryReport.payload));
    assert.ok(
      !januaryReport.payload.expenses.some((row: any) => row.id === createdExpenseId),
      "the corrected expense must be excluded from its original reporting period",
    );
    assert.equal(januaryReport.payload.correctionHistory.filter((row: any) =>
      row.recordType === "business_expense" && row.recordId === createdExpenseId).length, 0);
    assert.ok(
      !januaryReport.payload.ownerTransactions.some((row: any) => row.id === createdFundId),
      "the corrected owner-fund transaction must be excluded from its original reporting period",
    );
    assert.equal(januaryReport.payload.correctionHistory.filter((row: any) =>
      row.recordType === "owner_fund_transaction" && row.recordId === createdFundId).length, 0,
    "owner-fund correction history must not remain in the original period");
    const januaryBefore = new Map(januaryBeforeCorrection.payload.trialBalance.map((row: any) => [row.code, row]));
    const januaryAfter = new Map(januaryReport.payload.trialBalance.map((row: any) => [row.code, row]));
    assert.equal(
      (januaryAfter.get("1010") as any)?.balanceZmw,
      (januaryBefore.get("1010") as any)?.balanceZmw,
      "a later correction must not change an earlier cash balance",
    );
    assert.equal(
      (januaryAfter.get("3000") as any)?.balanceZmw,
      (januaryBefore.get("3000") as any)?.balanceZmw,
      "a later correction must not change earlier owner equity",
    );

    const reportResult = await request("/api/accounting?from=2002-01-01&to=2002-12-31");
    assert.equal(reportResult.response.status, 200, JSON.stringify(reportResult.payload));
    const corrections = await db.select().from(accountingCorrections).where(or(
      and(
        eq(accountingCorrections.recordType, "business_expense"),
        eq(accountingCorrections.recordId, createdExpenseId),
      ),
      and(
        eq(accountingCorrections.recordType, "owner_fund_transaction"),
        eq(accountingCorrections.recordId, createdFundId),
      ),
    )).orderBy(accountingCorrections.id);
    const expenseCorrections = corrections.filter((row) =>
      row.recordType === "business_expense" && row.recordId === createdExpenseId);
    const fundCorrections = corrections.filter((row) =>
      row.recordType === "owner_fund_transaction" && row.recordId === createdFundId);
    assert.equal(expenseCorrections.length, 4);
    assert.equal(fundCorrections.length, 4);
    const correctionAuditRows = await db.select().from(businessAuditLogs).where(and(
      eq(businessAuditLogs.entityType, "accounting_correction"),
      inArray(businessAuditLogs.entityId, corrections.map((correction) => correction.id)),
    ));
    assert.equal(correctionAuditRows.length, corrections.length);
    for (const correction of corrections) {
      const audit = correctionAuditRows.find((row) => row.entityId === correction.id);
      assert.equal(audit?.actorEmail, `${suffix}@example.test`, "the owner must remain identified in correction history");
      assert.ok(
        audit?.changedFields.includes(`reason: ${correction.reason}`),
        "the complete correction reason must remain visible in audit history",
      );
    }
    for (const chain of [expenseCorrections, fundCorrections]) {
      assert.equal(chain[0].previousCorrectionId, null);
      assert.equal(chain[1].previousCorrectionId, chain[0].id);
      for (const correction of chain) {
        assert.ok(correction.reversalEntryId, "each correction must have a reversal journal");
        assert.ok(correction.replacementEntryId, "each correction must have a replacement journal");
      }
    }
    const latestExpenseCorrection = expenseCorrections.at(-1)!;
    const latestFundCorrection = fundCorrections.at(-1)!;
    const reportExpense = reportResult.payload.expenses.find((row: any) => row.id === createdExpenseId);
    assert.equal(reportExpense.effective.category, latestExpenseCorrection.category);
    assert.equal(reportExpense.effective.amountZmw, latestExpenseCorrection.amountZmw);
    assert.equal(reportExpense.effective.expenseDate, latestExpenseCorrection.effectiveDate);
    assert.equal(reportExpense.effective.method, latestExpenseCorrection.method);
    assert.equal(reportExpense.correctionCount, expenseCorrections.length);
    const reportFund = reportResult.payload.ownerTransactions.find((row: any) => row.id === createdFundId);
    assert.equal(reportFund.effective.kind, latestFundCorrection.kind);
    assert.equal(reportFund.effective.amountZmw, latestFundCorrection.amountZmw);
    assert.equal(reportFund.effective.transactionDate, latestFundCorrection.effectiveDate);
    assert.equal(reportFund.effective.method, latestFundCorrection.method);
    assert.equal(reportFund.correctionCount, fundCorrections.length);
    assert.equal(reportResult.payload.totals.trialDebitsZmw, reportResult.payload.totals.trialCreditsZmw);
    assert.equal(reportResult.payload.correctionHistory.filter((row: any) =>
      (row.recordType === "business_expense" && row.recordId === createdExpenseId) ||
      (row.recordType === "owner_fund_transaction" && row.recordId === createdFundId)).length, 8);

    const marchReport = await request(
      `/api/accounting?from=${latestExpenseCorrection.effectiveDate}&to=${latestExpenseCorrection.effectiveDate}`,
    );
    assert.equal(marchReport.response.status, 200, JSON.stringify(marchReport.payload));
    const marchExpense = marchReport.payload.expenses.find((row: any) => row.id === createdExpenseId);
    assert.equal(marchExpense?.effective.expenseDate, latestExpenseCorrection.effectiveDate);
    assert.equal(marchExpense?.effective.amountZmw, latestExpenseCorrection.amountZmw);
    assert.equal(marchReport.payload.correctionHistory.filter((row: any) =>
      row.recordType === "business_expense" && row.recordId === createdExpenseId).length, expenseCorrections.length);
    assert.equal(marchReport.payload.ownerTransactions.some((row: any) => row.id === createdFundId), false,
      "a fund corrected on another date must not appear in the expense correction date report");

    const februaryReport = await request("/api/accounting?from=2002-02-01&to=2002-02-28");
    assert.equal(februaryReport.response.status, 200, JSON.stringify(februaryReport.payload));
    assert.ok(
      !februaryReport.payload.ownerTransactions.some((row: any) => row.id === createdFundId),
      "the owner-fund transaction must not appear in an unrelated reporting period",
    );
    assert.equal(februaryReport.payload.correctionHistory.filter((row: any) =>
      row.recordType === "owner_fund_transaction" && row.recordId === createdFundId).length, 0,
    "owner-fund correction history must not appear in an unrelated reporting period");

    const fundCorrectionDate = latestFundCorrection.effectiveDate;
    const fundCorrectionPeriod = await request(
      `/api/accounting?from=${fundCorrectionDate}&to=${fundCorrectionDate}`,
    );
    assert.equal(fundCorrectionPeriod.response.status, 200, JSON.stringify(fundCorrectionPeriod.payload));
    const correctedFundInPeriod = fundCorrectionPeriod.payload.ownerTransactions.find((row: any) => row.id === createdFundId);
    assert.ok(correctedFundInPeriod, "the corrected owner-fund transaction must appear in its effective period");
    assert.equal(correctedFundInPeriod.effective.transactionDate, fundCorrectionDate);
    assert.equal(correctedFundInPeriod.effective.kind, latestFundCorrection.kind);
    assert.equal(correctedFundInPeriod.effective.amountZmw, latestFundCorrection.amountZmw);
    const fundHistoryInPeriod = fundCorrectionPeriod.payload.correctionHistory.filter((row: any) =>
      row.recordType === "owner_fund_transaction" && row.recordId === createdFundId);
    assert.equal(fundHistoryInPeriod.length, fundCorrections.length);
    assert.ok(fundHistoryInPeriod.every((row: any) => row.effectiveDate === fundCorrectionDate),
      "owner-fund correction history must follow the effective correction date");
    const expenseAccount = reportResult.payload.accounts.find((account: any) =>
      account.systemKey === operatingExpenseAccountKey(latestExpenseCorrection.category ?? "other"));
    assert.equal(
      marchReport.payload.incomeStatement.find((row: any) => row.code === expenseAccount.code)?.amountZmw,
      latestExpenseCorrection.amountZmw,
      "the corrected expense account and amount must appear in the correction period report",
    );

    const relatedJournalIds = corrections.flatMap((correction) => [
      correction.reversalEntryId, correction.replacementEntryId,
    ]).filter((id): id is number => id !== null);
    const journalRows = await db.select().from(journalEntries).where(inArray(journalEntries.id, relatedJournalIds));
    assert.equal(journalRows.length, 16);
    for (const entry of journalRows) {
      const lines = await db.select().from(journalLines).where(eq(journalLines.journalEntryId, entry.id));
      const debits = lines.reduce((sum, line) => sum + Math.round(Number(line.debitZmw) * 100), 0);
      const credits = lines.reduce((sum, line) => sum + Math.round(Number(line.creditZmw) * 100), 0);
      assert.ok(debits > 0);
      assert.equal(debits, credits, `${entry.entryNumber} must remain balanced`);
    }
    for (const chain of [expenseCorrections, fundCorrections]) {
      const originalSourceKey = chain[0].recordType === "business_expense"
        ? `business-expense-${createdExpenseId}`
        : `owner-fund-${createdFundId}`;
      let previousEntry = (await db.select().from(journalEntries)
        .where(eq(journalEntries.sourceKey, originalSourceKey)).limit(1))[0];
      assert.ok(previousEntry, "the original journal must exist");
      for (const correction of chain) {
        const reversal = journalRows.find((entry) => entry.id === correction.reversalEntryId);
        const replacement = journalRows.find((entry) => entry.id === correction.replacementEntryId);
        assert.ok(reversal);
        assert.ok(replacement);
        assert.equal(reversal.sourceType, "accounting_correction_reversal");
        assert.equal(reversal.sourceId, correction.id);
        assert.equal(replacement.sourceType, "accounting_correction");
        assert.equal(replacement.sourceId, correction.id);
        const previousLines = await db.select().from(journalLines)
          .where(eq(journalLines.journalEntryId, previousEntry.id));
        const reversalLines = await db.select().from(journalLines)
          .where(eq(journalLines.journalEntryId, reversal.id));
        const lineKey = (line: typeof previousLines[number], reverse = false) => [
          line.accountId,
          line.productId ?? "",
          reverse ? line.creditZmw : line.debitZmw,
          reverse ? line.debitZmw : line.creditZmw,
        ].join(":");
        assert.deepEqual(
          reversalLines.map((line) => lineKey(line)).sort(),
          previousLines.map((line) => lineKey(line, true)).sort(),
          `${reversal.entryNumber} must reverse the immediately prior journal`,
        );
        if (correction.recordType === "business_expense") {
          const [selectedCashAccount] = await db.select().from(accountingAccounts)
            .where(eq(
              accountingAccounts.systemKey,
              cashAccountKeyForMethod(correction.method as "cash" | "bank_transfer" | "mobile_money" | "other"),
            ));
          assert.ok(selectedCashAccount, `the ${correction.method} account must exist`);
          const replacementLines = await db.select().from(journalLines)
            .where(eq(journalLines.journalEntryId, replacement.id));
          assert.ok(
            replacementLines.some((line) =>
              line.accountId === selectedCashAccount.id &&
              line.creditZmw === correction.amountZmw),
            `${replacement.entryNumber} must credit the selected ${correction.method} account`,
          );
        } else {
          const [selectedCashAccount] = await db.select().from(accountingAccounts)
            .where(eq(
              accountingAccounts.systemKey,
              cashAccountKeyForMethod(correction.method as "cash" | "bank_transfer" | "mobile_money" | "other"),
            ));
          assert.ok(selectedCashAccount, `the ${correction.method} account must exist`);
          const replacementLines = await db.select().from(journalLines)
            .where(eq(journalLines.journalEntryId, replacement.id));
          const cashSide = correction.kind === "owner_withdrawal" ? "creditZmw" : "debitZmw";
          assert.ok(
            replacementLines.some((line) =>
              line.accountId === selectedCashAccount.id && line[cashSide] === correction.amountZmw),
            `${replacement.entryNumber} must post owner funds to the selected ${correction.method} account`,
          );
        }
        previousEntry = replacement;
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (correctionFailureTrigger) {
      await pool.query(`DROP TRIGGER IF EXISTS ${correctionFailureTrigger} ON journal_entries`);
    }
    if (correctionFailureFunction) {
      await pool.query(`DROP FUNCTION IF EXISTS ${correctionFailureFunction}()`);
    }
    const ids = [expenseId, fundId].filter((id): id is number => id !== null);
    if (ids.length) {
      const correctionFilter = or(
        ...(expenseId ? [and(
          eq(accountingCorrections.recordType, "business_expense"),
          eq(accountingCorrections.recordId, expenseId),
        )] : []),
        ...(fundId ? [and(
          eq(accountingCorrections.recordType, "owner_fund_transaction"),
          eq(accountingCorrections.recordId, fundId),
        )] : []),
      );
      const corrections = await db.select().from(accountingCorrections)
        .where(correctionFilter)
        .orderBy(accountingCorrections.id);
      for (const correction of [...corrections].reverse()) {
        await db.delete(businessAuditLogs).where(and(
          eq(businessAuditLogs.entityType, "accounting_correction"),
          eq(businessAuditLogs.entityId, correction.id),
        ));
        await db.delete(accountingCorrections).where(eq(accountingCorrections.id, correction.id));
      }
      const sourceKeys = [
        ...(expenseId ? [`business-expense-${expenseId}`] : []),
        ...(fundId ? [`owner-fund-${fundId}`] : []),
        ...corrections.flatMap((correction) => [
          `accounting-correction-${correction.id}-reversal`,
          `accounting-correction-${correction.id}-replacement`,
        ]),
      ];
      const entries = await db.select({ id: journalEntries.id }).from(journalEntries)
        .where(inArray(journalEntries.sourceKey, sourceKeys));
      const entryIds = entries.map((entry) => entry.id);
      if (entryIds.length) {
        await db.delete(journalLines).where(inArray(journalLines.journalEntryId, entryIds));
        await db.delete(businessAuditLogs).where(and(
          eq(businessAuditLogs.entityType, "journal_entry"),
          inArray(businessAuditLogs.entityId, entryIds),
        ));
        await db.delete(journalEntries).where(inArray(journalEntries.id, entryIds));
      }
      if (expenseId) {
        await db.delete(businessAuditLogs).where(and(
          eq(businessAuditLogs.entityType, "business_expense"),
          eq(businessAuditLogs.entityId, expenseId),
        ));
        await db.delete(businessExpenses).where(eq(businessExpenses.id, expenseId));
      }
      if (fundId) {
        await db.delete(businessAuditLogs).where(and(
          eq(businessAuditLogs.entityType, "owner_fund_transaction"),
          eq(businessAuditLogs.entityId, fundId),
        ));
        await db.delete(ownerFundTransactions).where(eq(ownerFundTransactions.id, fundId));
      }
    }
    await pool.end();
  }
});
