import { desc, eq, lte } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { accountingAccounts, journalEntries, journalLines } from "../shared/schema";
import { db } from "./db";
import { ensureAccountingAccounts } from "./accounting-posting";

const dateQuery = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cents = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
};
const money = (value: bigint) => {
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
};

export function registerAccountingRoutes(app: Express, owner: RequestHandler) {
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
