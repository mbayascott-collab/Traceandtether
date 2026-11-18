import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { and, eq, inArray, or } from "drizzle-orm";
import test from "node:test";
import {
  accountingCorrections, businessAuditLogs, businessExpenses, journalEntries, journalLines, ownerFundTransactions,
} from "../shared/schema";

test("expense and owner-fund corrections preserve originals and post linked balanced journals", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db, pool }, { registerAccountingRoutes }] = await Promise.all([
    import("./db"),
    import("./accounting-routes"),
  ]);
  const suffix = randomUUID();
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `correction-test-${suffix}`, email: `${suffix}@example.test`, role: "owner" };
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
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
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

    const firstExpenseCorrection = await request(`/api/accounting/expenses/${createdExpenseId}/correct`, {
      category: "rent",
      description: `Corrected expense ${suffix}`,
      amountZmw: "15.75",
      expenseDate: "2002-02-10",
      method: "bank_transfer",
      reference: `corrected-expense-${suffix}`,
      notes: "Corrected expense note",
      reason: "Wrong account and amount",
    });
    assert.equal(firstExpenseCorrection.response.status, 201, JSON.stringify(firstExpenseCorrection.payload));
    const secondExpenseCorrection = await request(`/api/accounting/expenses/${createdExpenseId}/correct`, {
      category: "utilities",
      description: `Final expense ${suffix}`,
      amountZmw: "18.25",
      expenseDate: "2002-03-10",
      method: "mobile_money",
      reference: `final-expense-${suffix}`,
      notes: "Final corrected note",
      reason: "Corrected date and amount",
    });
    assert.equal(secondExpenseCorrection.response.status, 201, JSON.stringify(secondExpenseCorrection.payload));

    const fundResult = await request("/api/accounting/funds", {
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
    const fundCorrection = await request(`/api/accounting/funds/${createdFundId}/correct`, {
      kind: "business_loan",
      amountZmw: "30.00",
      receivedAt: "2002-02-12",
      method: "bank_transfer",
      reference: `corrected-fund-${suffix}`,
      notes: "Corrected loan",
      reason: "It was a loan, not a contribution",
    });
    assert.equal(fundCorrection.response.status, 201, JSON.stringify(fundCorrection.payload));

    const [originalExpense] = await db.select().from(businessExpenses).where(eq(businessExpenses.id, createdExpenseId));
    assert.equal(originalExpense.amountZmw, "10.00");
    assert.equal(originalExpense.category, "other");
    assert.equal(originalExpense.expenseDate, "2002-01-10");
    const [originalFund] = await db.select().from(ownerFundTransactions).where(eq(ownerFundTransactions.id, createdFundId));
    assert.equal(originalFund.amountZmw, "25.00");
    assert.equal(originalFund.kind, "owner_contribution");
    assert.equal(originalFund.transactionDate, "2002-01-12");

    const reportResult = await request("/api/accounting?from=2002-01-01&to=2002-12-31");
    assert.equal(reportResult.response.status, 200, JSON.stringify(reportResult.payload));
    const reportExpense = reportResult.payload.expenses.find((row: any) => row.id === createdExpenseId);
    assert.equal(reportExpense.effective.category, "utilities");
    assert.equal(reportExpense.effective.amountZmw, "18.25");
    assert.equal(reportExpense.effective.expenseDate, "2002-03-10");
    assert.equal(reportExpense.correctionCount, 2);
    const reportFund = reportResult.payload.ownerTransactions.find((row: any) => row.id === createdFundId);
    assert.equal(reportFund.effective.kind, "business_loan");
    assert.equal(reportFund.effective.amountZmw, "30.00");
    assert.equal(reportFund.correctionCount, 1);
    assert.equal(reportResult.payload.correctionHistory.filter((row: any) =>
      (row.recordType === "business_expense" && row.recordId === createdExpenseId) ||
      (row.recordType === "owner_fund_transaction" && row.recordId === createdFundId)).length, 3);

    const marchReport = await request("/api/accounting?from=2002-03-10&to=2002-03-10");
    assert.equal(marchReport.response.status, 200, JSON.stringify(marchReport.payload));
    assert.equal(
      marchReport.payload.incomeStatement.find((row: any) => row.code === "6500")?.amountZmw,
      "18.25",
      "the corrected expense account and amount must appear in the correction period report",
    );

    const corrections = await db.select().from(accountingCorrections).where(or(
      and(
        eq(accountingCorrections.recordType, "business_expense"),
        eq(accountingCorrections.recordId, createdExpenseId),
      ),
      and(
        eq(accountingCorrections.recordType, "owner_fund_transaction"),
        eq(accountingCorrections.recordId, createdFundId),
      ),
    ));
    assert.equal(corrections.length, 3);
    const relatedJournalIds = corrections.flatMap((correction) => [
      correction.reversalEntryId, correction.replacementEntryId,
    ]).filter((id): id is number => id !== null);
    const journalRows = await db.select().from(journalEntries).where(inArray(journalEntries.id, relatedJournalIds));
    assert.equal(journalRows.length, 6);
    for (const entry of journalRows) {
      const lines = await db.select().from(journalLines).where(eq(journalLines.journalEntryId, entry.id));
      const debits = lines.reduce((sum, line) => sum + Math.round(Number(line.debitZmw) * 100), 0);
      const credits = lines.reduce((sum, line) => sum + Math.round(Number(line.creditZmw) * 100), 0);
      assert.ok(debits > 0);
      assert.equal(debits, credits, `${entry.entryNumber} must remain balanced`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
