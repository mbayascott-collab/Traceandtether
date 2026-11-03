import { desc, eq } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import { accountingAccounts, journalEntries, journalLines } from "../shared/schema";
import { db } from "./db";
import { ensureAccountingAccounts } from "./accounting-posting";

export function registerAccountingRoutes(app: Express, owner: RequestHandler) {
  app.get("/api/accounting", owner, async (_req, res) => {
    const result = await db.transaction(async (tx) => {
      await ensureAccountingAccounts(tx);
      const [accountRows, entries, lines] = await Promise.all([
        tx.select().from(accountingAccounts).orderBy(accountingAccounts.code),
        tx.select().from(journalEntries).orderBy(desc(journalEntries.createdAt)).limit(100),
        tx.select({ line: journalLines, accountName: accountingAccounts.name, accountCode: accountingAccounts.code })
          .from(journalLines).innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id)),
      ]);
      const balances = new Map<number, bigint>();
      for (const { line } of lines) {
        const debit = BigInt(line.debitZmw.replace(".", ""));
        const credit = BigInt(line.creditZmw.replace(".", ""));
        balances.set(line.accountId, (balances.get(line.accountId) ?? 0n) + debit - credit);
      }
      const accounts = accountRows.map((account) => {
        const raw = balances.get(account.id) ?? 0n;
        const creditNormal = account.type === "liability" || account.type === "equity" || account.type === "income";
        const value = creditNormal ? -raw : raw;
        const absolute = value < 0n ? -value : value;
        return { ...account, balanceZmw: `${value < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}` };
      });
      return {
        accounts,
        entries: entries.map((entry) => ({
          ...entry,
          lines: lines.filter(({ line }) => line.journalEntryId === entry.id)
            .map(({ line, accountName, accountCode }) => ({ ...line, accountName, accountCode })),
        })),
      };
    });
    res.json(result);
  });
}
