import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { accountingAccounts, businessExpenses, journalEntries, journalLines, ownerFundTransactions } from "../shared/schema";
import { db } from "./db";
import { recordBusinessAudit } from "./audit";
import {
  buildOpeningBalanceLines, cashAccountKeyForMethod, ensureAccountingAccounts,
  buildOwnerFundLines, journalLinesAreBalanced, operatingExpenseAccountKey, ownerFundAccountKey, postJournal,
} from "./accounting-posting";

const dateQuery = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const cents = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
};
const money = (value: bigint) => {
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
};
const cashInSchema = z.object({
  kind: z.enum(["owner_contribution", "business_loan", "owner_withdrawal"]),
  amountZmw: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/),
  receivedAt: z.string().refine((value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }),
  method: z.enum(["cash", "bank_transfer", "mobile_money", "other"]),
  reference: z.string().trim().max(120).optional().default(""),
  notes: z.string().trim().max(500).optional().default(""),
});
const expenseSchema = z.object({
  category: z.enum(["rent", "office_supplies", "utilities", "transport", "repairs", "other"]),
  description: z.string().trim().min(2).max(240),
  amountZmw: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/),
  expenseDate: dateQuery,
  method: z.enum(["cash", "bank_transfer", "mobile_money", "other"]),
  reference: z.string().trim().max(120).optional().default(""),
  notes: z.string().trim().max(1000).optional().default(""),
});
const openingBalanceSchema = z.object({
  effectiveAt: dateQuery,
  cashOnHandZmw: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/),
  bankZmw: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/),
  mobileMoneyZmw: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/),
  otherFundsZmw: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/),
  receivablesZmw: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/),
  payablesZmw: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/),
  loansPayableZmw: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/),
  ownerEquityZmw: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/),
  memo: z.string().trim().min(3).max(500),
});
const OPENING_BALANCE_SOURCE_KEY = "opening-balances-v1";

export function registerAccountingRoutes(app: Express, owner: RequestHandler) {
  app.post("/api/accounting/expenses", owner, async (req, res) => {
    const parsed = expenseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the expense details." });
      return;
    }
    const input = parsed.data;
    const amount = cents(input.amountZmw);
    if (amount <= 0n) {
      res.status(400).json({ error: "Enter an expense amount greater than zero." });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [expense] = await tx.insert(businessExpenses).values({
        category: input.category,
        description: input.description,
        amountZmw: input.amountZmw,
        expenseDate: input.expenseDate,
        method: input.method,
        reference: input.reference || null,
        notes: input.notes || null,
      }).returning();
      await recordBusinessAudit(tx, {
        entityType: "business_expense", entityId: expense.id,
        recordLabel: `${expense.category}: ${expense.description}`,
        actor: res.locals.actor, action: "created", changedFields: Object.keys(input),
      });
      const accountKey = operatingExpenseAccountKey(input.category);
      const cashKey = cashAccountKeyForMethod(input.method);
      const accountNames = await ensureAccountingAccounts(tx);
      const expenseAccount = accountNames.get(accountKey);
      const cashAccount = accountNames.get(cashKey);
      if (!expenseAccount || !cashAccount) throw new Error("A required expense account is unavailable.");
      const journal = await postJournal(tx, {
        sourceKey: `business-expense-${expense.id}`,
        sourceType: "business_expense",
        sourceId: expense.id,
        memo: `${expenseAccount.name}: ${input.description}${input.reference ? ` · ${input.reference}` : ""}`,
        entryDate: input.expenseDate,
        lines: [
          { accountKey, debitZmw: input.amountZmw, description: input.notes || input.description },
          { accountKey: cashKey, creditZmw: input.amountZmw, description: `Paid by ${input.method}` },
        ],
      });
      return { expense, journal };
    });
    res.status(201).json(result);
  });

  app.post("/api/accounting/opening-balances", owner, async (req, res) => {
    const parsed = openingBalanceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the opening balance details." });
      return;
    }
    const input = parsed.data;
    const amounts = [
      input.cashOnHandZmw, input.bankZmw, input.mobileMoneyZmw, input.otherFundsZmw,
      input.receivablesZmw, input.payablesZmw,
      input.loansPayableZmw, input.ownerEquityZmw,
    ];
    if (amounts.every((amount) => cents(amount) === 0n)) {
      res.status(400).json({ error: "Enter at least one opening balance greater than zero." });
      return;
    }
    const lines = buildOpeningBalanceLines(input);
    if (!journalLinesAreBalanced(lines)) {
      res.status(400).json({ error: "Opening balances must contain at least one amount." });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(journalEntries)
        .where(eq(journalEntries.sourceKey, OPENING_BALANCE_SOURCE_KEY)).limit(1);
      if (existing) return { alreadyExists: true };

      const accountMap = await ensureAccountingAccounts(tx);
      if (lines.some((line) => !accountMap.has(line.accountKey))) {
        throw new Error("A required opening balance account is unavailable.");
      }
      const [entry] = await tx.insert(journalEntries).values({
        entryNumber: `JE-${input.effectiveAt.slice(0, 4)}-${randomUUID().slice(0, 8).toUpperCase()}`,
        sourceKey: OPENING_BALANCE_SOURCE_KEY,
        sourceType: "opening_balances",
        sourceId: null,
        entryDate: input.effectiveAt,
        memo: input.memo,
      }).returning();
      await recordBusinessAudit(tx, {
        entityType: "journal_entry", entityId: entry.id, recordLabel: entry.entryNumber,
        actor: res.locals.actor, action: "created", changedFields: ["entryDate", "memo", "openingBalances"],
      });
      await tx.insert(journalLines).values(lines.map((line) => {
        const account = accountMap.get(line.accountKey)!;
        return {
          journalEntryId: entry.id,
          accountId: account.id,
          debitZmw: line.debitZmw ?? "0.00",
          creditZmw: line.creditZmw ?? "0.00",
          description: line.description ?? null,
        };
      }));
      return { alreadyExists: false };
    });
    if (result.alreadyExists) {
      res.status(409).json({ error: "Opening balances have already been recorded and cannot be replaced here." });
      return;
    }
    res.status(201).json({ message: "Opening balances recorded." });
  });

  app.post("/api/accounting/funds", owner, async (req, res) => {
    const parsed = cashInSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the cash-in details." });
      return;
    }
    const input = parsed.data;
    let amount: bigint;
    try { amount = cents(input.amountZmw); } catch { amount = 0n; }
    if (amount <= 0n) {
      res.status(400).json({ error: "Enter an amount greater than zero." });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const accountMap = await ensureAccountingAccounts(tx);
      const cashAccountKey = cashAccountKeyForMethod(input.method);
      const cashAccount = accountMap.get(cashAccountKey);
      const fundAccountKey = ownerFundAccountKey(input.kind);
      const fundAccount = accountMap.get(fundAccountKey);
      if (!cashAccount || !fundAccount) throw new Error("Required accounting accounts are unavailable.");
      const [transaction] = await tx.insert(ownerFundTransactions).values({
        kind: input.kind,
        accountId: fundAccount.id,
        amountZmw: input.amountZmw,
        transactionDate: input.receivedAt,
        method: input.method,
        reference: input.reference || null,
        notes: input.notes || null,
      }).returning();
      await recordBusinessAudit(tx, {
        entityType: "owner_fund_transaction", entityId: transaction.id,
        recordLabel: input.reference || input.kind,
        actor: res.locals.actor, action: "created",
        changedFields: ["kind", "amountZmw", "transactionDate", "accountId", "method", "reference", "notes"],
      });
      const lines = buildOwnerFundLines(input.kind, input.method, input.amountZmw, cashAccount.name, input.notes);
      if (!journalLinesAreBalanced(lines)) throw new Error("Owner transaction journal is not balanced.");
      const memo = input.kind === "owner_contribution"
        ? "Owner contribution"
        : input.kind === "business_loan" ? "Business loan received" : "Owner withdrawal";
      const journal = await postJournal(tx, {
        sourceKey: `owner-fund-${transaction.id}`,
        sourceType: input.kind,
        sourceId: transaction.id,
        entryDate: input.receivedAt,
        memo: `${memo}${input.reference ? ` · ${input.reference}` : ""}`,
        lines,
      });
      return { transaction, journal };
    });
    res.status(201).json(result);
  });

  app.get("/api/accounting", owner, async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const year = today.slice(0, 4);
    const from = String(req.query.from ?? `${year}-01-01`);
    const to = String(req.query.to ?? today);
    if (!dateQuery.safeParse(from).success || !dateQuery.safeParse(to).success || from > to) {
      res.status(400).json({ error: "Choose a valid start and end date." });
      return;
    }

    const result = await db.transaction(async (tx) => {
      await ensureAccountingAccounts(tx);
      const accounts = await tx.select().from(accountingAccounts).orderBy(accountingAccounts.code);
      const [openingBalanceEntry] = await tx.select({
        entryDate: journalEntries.entryDate,
      }).from(journalEntries)
        .where(eq(journalEntries.sourceKey, OPENING_BALANCE_SOURCE_KEY)).limit(1);
      const expenses = await tx.select().from(businessExpenses)
        .where(and(gte(businessExpenses.expenseDate, from), lte(businessExpenses.expenseDate, to)))
        .orderBy(desc(businessExpenses.expenseDate), desc(businessExpenses.id));
      const ownerTransactions = await tx.select({
        id: ownerFundTransactions.id,
        kind: ownerFundTransactions.kind,
        amountZmw: ownerFundTransactions.amountZmw,
        transactionDate: ownerFundTransactions.transactionDate,
        method: ownerFundTransactions.method,
        reference: ownerFundTransactions.reference,
        accountName: accountingAccounts.name,
      }).from(ownerFundTransactions)
        .innerJoin(accountingAccounts, eq(ownerFundTransactions.accountId, accountingAccounts.id))
        .where(and(gte(ownerFundTransactions.transactionDate, from), lte(ownerFundTransactions.transactionDate, to)))
        .orderBy(desc(ownerFundTransactions.transactionDate), desc(ownerFundTransactions.id));
      const records = await tx.select({
        entry: journalEntries,
        line: journalLines,
        accountName: accountingAccounts.name,
        accountCode: accountingAccounts.code,
        accountType: accountingAccounts.type,
        accountId: accountingAccounts.id,
      }).from(journalLines)
        .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
        .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
        .where(lte(journalEntries.entryDate, to))
        .orderBy(desc(journalEntries.entryDate), desc(journalEntries.id));

      const accountBalance = new Map<number, bigint>();
      const periodBalance = new Map<number, bigint>();
      const entryMap = new Map<number, {
        id: number; entryNumber: string; memo: string; entryDate: string; sourceType: string;
        lines: Array<{ accountCode: string; accountName: string; debitZmw: string; creditZmw: string; description: string | null }>;
      }>();
      for (const row of records) {
        const debit = cents(row.line.debitZmw);
        const credit = cents(row.line.creditZmw);
        accountBalance.set(row.accountId, (accountBalance.get(row.accountId) ?? 0n) + debit - credit);
        if (row.entry.entryDate >= from && ["income", "expense"].includes(row.accountType)) {
          periodBalance.set(row.accountId, (periodBalance.get(row.accountId) ?? 0n) + debit - credit);
        }
        if (row.entry.entryDate >= from && !entryMap.has(row.entry.id)) {
          entryMap.set(row.entry.id, {
            id: row.entry.id, entryNumber: row.entry.entryNumber, memo: row.entry.memo,
            entryDate: row.entry.entryDate, sourceType: row.entry.sourceType, lines: [],
          });
        }
        const entry = entryMap.get(row.entry.id);
        if (entry) entry.lines.push({
          accountCode: row.accountCode, accountName: row.accountName,
          debitZmw: row.line.debitZmw, creditZmw: row.line.creditZmw, description: row.line.description,
        });
      }

      const trialBalance = accounts.map((account) => {
        const raw = accountBalance.get(account.id) ?? 0n;
        return {
          accountId: account.id, code: account.code, name: account.name, type: account.type,
          debitZmw: money(raw > 0n ? raw : 0n), creditZmw: money(raw < 0n ? -raw : 0n),
          balanceZmw: money(account.type === "liability" || account.type === "equity" || account.type === "income" ? -raw : raw),
        };
      });
      const incomeStatement = accounts.filter((account) => account.type === "income" || account.type === "expense")
        .map((account) => {
          const raw = periodBalance.get(account.id) ?? 0n;
          const value = account.type === "income" ? -raw : raw;
          return { code: account.code, name: account.name, type: account.type, amountZmw: money(value) };
        });
      const incomeCents = incomeStatement.filter((row) => row.type === "income").reduce((sum, row) => sum + cents(row.amountZmw), 0n);
      const expenseCents = incomeStatement.filter((row) => row.type === "expense").reduce((sum, row) => sum + cents(row.amountZmw), 0n);
      const balanceSheet = accounts.filter((account) => ["asset", "liability", "equity"].includes(account.type))
        .map((account) => ({
          code: account.code, name: account.name, type: account.type,
          amountZmw: money((accountBalance.get(account.id) ?? 0n) *
            (account.type === "liability" || account.type === "equity" ? -1n : 1n)),
        }));
      const lifetimeProfit = records.reduce((sum, row) => {
        if (row.accountType === "income") return sum + cents(row.line.creditZmw) - cents(row.line.debitZmw);
        if (row.accountType === "expense") return sum + cents(row.line.debitZmw) - cents(row.line.creditZmw);
        return sum;
      }, 0n);
      balanceSheet.push({ code: "", name: "Accumulated earnings (not closed)", type: "equity", amountZmw: money(lifetimeProfit) });
      return {
        accounts,
        openingBalances: { posted: Boolean(openingBalanceEntry), entryDate: openingBalanceEntry?.entryDate ?? null },
        expenses,
        ownerTransactions,
        entries: [...entryMap.values()],
        trialBalance,
        incomeStatement,
        balanceSheet,
        totals: {
          trialDebitsZmw: money(trialBalance.reduce((sum, row) => sum + cents(row.debitZmw), 0n)),
          trialCreditsZmw: money(trialBalance.reduce((sum, row) => sum + cents(row.creditZmw), 0n)),
          incomeZmw: money(incomeCents), expensesZmw: money(expenseCents),
          netIncomeZmw: money(incomeCents - expenseCents),
        },
        from, to,
      };
    });
    res.json(result);
  });
}
