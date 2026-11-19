import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import test from "node:test";
import {
  accountingAccounts, businessAuditLogs, businessExpenses, journalEntries, journalLines,
} from "../shared/schema";
import { journalLinesAreBalanced } from "./accounting-posting";

test("expense routes credit only the selected funds account and preserve prior postings", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db, pool }, { registerAccountingRoutes }] = await Promise.all([
    import("./db"),
    import("./accounting-routes"),
  ]);
  const suffix = randomUUID();
  const actorEmail = `business-expense-posting-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
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
  const savedExpenseIds: number[] = [];
  const savedJournalIds: number[] = [];
  const request = async (path: string, body: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as any;
    assert.equal(response.status, 201, JSON.stringify(payload));
    return payload;
  };
  const getReport = async () => {
    const response = await fetch(`${baseUrl}/api/accounting?from=2001-02-01&to=2001-03-31`);
    const payload = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload;
  };
  const toCents = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  };
  const netTrialBalance = (report: any, code: string) => {
    const row = report.trialBalance.find((account: any) => account.code === code);
    assert.ok(row, `report should include account ${code}`);
    return toCents(row.debitZmw) - toCents(row.creditZmw);
  };
  const getPostedEntry = async (entryId: number) => {
    const [entry] = await db.select().from(journalEntries).where(eq(journalEntries.id, entryId));
    const lines = await db.select({
      id: journalLines.id,
      accountKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
      description: journalLines.description,
    }).from(journalLines)
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalLines.journalEntryId, entryId))
      .orderBy(journalLines.id);
    return { entry, lines };
  };

  let historicalExpense: typeof businessExpenses.$inferSelect | undefined;
  let historicalPosting: Awaited<ReturnType<typeof getPostedEntry>> | undefined;
  try {
    const reportBeforePosting = await getReport();
    const cases = [
      { method: "cash", fundsAccount: "cash_on_hand", expenseDate: "2001-01-01" },
      { method: "bank_transfer", fundsAccount: "bank_account", expenseDate: "2001-02-01" },
      { method: "mobile_money", fundsAccount: "mobile_money", expenseDate: "2001-03-01" },
      { method: "other", fundsAccount: "other_funds", expenseDate: "2001-04-01" },
    ] as const;

    for (const { method, fundsAccount, expenseDate } of cases) {
      const result = await request("/api/accounting/expenses", {
        category: "rent",
        description: `Funds account regression ${suffix} ${method}`,
        amountZmw: "12.34",
        expenseDate,
        method,
        reference: `${suffix}-${method}`,
        notes: "Verify expense account and payment account",
      });
      const expenseId = Number(result.expense.id);
      const journalId = Number(result.journal.id);
      savedExpenseIds.push(expenseId);
      savedJournalIds.push(journalId);

      const [expense] = await db.select().from(businessExpenses)
        .where(eq(businessExpenses.id, expenseId));
      assert.equal(expense.method, method);
      assert.equal(expense.amountZmw, "12.34");

      const { entry, lines } = await getPostedEntry(journalId);
      assert.equal(entry.sourceType, "business_expense");
      assert.equal(entry.sourceId, expenseId);
      assert.equal(entry.sourceKey, `business-expense-${expenseId}`);
      assert.equal(lines.length, 2);
      assert.deepEqual(lines.map((line) => line.accountKey), ["rent_expense", fundsAccount]);
      assert.equal(lines[0].debitZmw, "12.34");
      assert.equal(lines[0].creditZmw, "0.00");
      assert.equal(lines[1].debitZmw, "0.00");
      assert.equal(lines[1].creditZmw, "12.34");
      assert.equal(journalLinesAreBalanced(lines.map((line) => ({
        accountKey: line.accountKey!,
        debitZmw: line.debitZmw,
        creditZmw: line.creditZmw,
      }))), true);

      if (!historicalExpense) {
        historicalExpense = expense;
        historicalPosting = { entry, lines };
      } else {
        const [unchangedExpense] = await db.select().from(businessExpenses)
          .where(eq(businessExpenses.id, historicalExpense.id));
        assert.deepEqual(unchangedExpense, historicalExpense);
        assert.deepEqual(await getPostedEntry(historicalPosting!.entry.id), historicalPosting);
      }
    }

    const reportAfterPosting = await getReport();
    assert.equal(
      toCents(reportAfterPosting.totals.expensesZmw) - toCents(reportBeforePosting.totals.expensesZmw),
      2468n,
      "the report includes only the bank and mobile-money expenses dated inside the period",
    );
    assert.deepEqual(
      ["1010", "1020", "1030", "1040"].map((code) =>
        netTrialBalance(reportAfterPosting, code) - netTrialBalance(reportBeforePosting, code)),
      [-1234n, -1234n, -1234n, 0n],
      "reported fund balances reflect posted credits through the report end and exclude later postings",
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (savedJournalIds.length) {
      await db.delete(journalLines).where(inArray(journalLines.journalEntryId, savedJournalIds));
      await db.delete(businessAuditLogs).where(and(
        eq(businessAuditLogs.entityType, "journal_entry"),
        inArray(businessAuditLogs.entityId, savedJournalIds),
      ));
      await db.delete(journalEntries).where(inArray(journalEntries.id, savedJournalIds));
    }
    if (savedExpenseIds.length) {
      for (const expenseId of savedExpenseIds) {
        await db.delete(businessAuditLogs).where(and(
          eq(businessAuditLogs.entityType, "business_expense"),
          eq(businessAuditLogs.entityId, expenseId),
        ));
      }
      await db.delete(businessExpenses).where(inArray(businessExpenses.id, savedExpenseIds));
    }
    await pool.end();
  }
});
