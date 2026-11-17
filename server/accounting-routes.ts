import { desc, eq, lte } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { accountingAccounts, journalEntries, journalLines } from "../shared/schema";
import { db } from "./db";
import {
  buildOpeningBalanceLines, cashAccountKeyForMethod, ensureAccountingAccounts, journalLinesAreBalanced,
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
  kind: z.enum(["owner_contribution", "business_loan"]),
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
    const sourceKey = `funding-${randomUUID()}`;
    await db.transaction(async (tx) => {
      const accountMap = await ensureAccountingAccounts(tx);
      const cashAccountKey = cashAccountKeyForMethod(input.method);
      const cashAccount = accountMap.get(cashAccountKey);
      const offsetAccount = accountMap.get(input.kind === "owner_contribution" ? "owner_equity" : "business_loans_payable");
      if (!cashAccount || !offsetAccount) throw new Error("Required accounting accounts are unavailable.");
      if (!journalLinesAreBalanced([
        { accountKey: cashAccountKey, debitZmw: input.amountZmw },
        { accountKey: input.kind === "owner_contribution" ? "owner_equity" : "business_loans_payable", creditZmw: input.amountZmw },
      ])) throw new Error("Cash-in journal is not balanced.");
      const [entry] = await tx.insert(journalEntries).values({
        entryNumber: `JE-${input.receivedAt.slice(0, 4)}-${randomUUID().slice(0, 8).toUpperCase()}`,
        sourceKey, sourceType: input.kind, sourceId: null,
        entryDate: input.receivedAt,
        memo: `${input.kind === "owner_contribution" ? "Owner contribution" : "Business loan received"}${input.reference ? ` · ${input.reference}` : ""}`,
      }).returning();
      await tx.insert(journalLines).values([
        {
          journalEntryId: entry.id, accountId: cashAccount.id, debitZmw: input.amountZmw, creditZmw: "0.00",
          description: `Received into ${cashAccount.name}${input.notes ? ` · ${input.notes.slice(0, 190)}` : ""}`,
        },
        {
          journalEntryId: entry.id, accountId: offsetAccount.id, debitZmw: "0.00", creditZmw: input.amountZmw,
          description: input.kind === "owner_contribution" ? "Owner funds added" : "Loan principal received",
        },
      ]);
    });
    res.status(201).json({ message: "Cash-in recorded." });
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
