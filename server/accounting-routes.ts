import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { accountingAccounts, businessExpenses, journalEntries, journalLines, ownerFundTransactions } from "../shared/schema";
import { db } from "./db";
import { recordBusinessAudit } from "./audit";
import { databaseErrorStatus } from "./database-errors";
import {
  buildOpeningBalanceLines, cashAccountKeyForMethod, ensureAccountingAccounts, reversePostingLines,
  buildOwnerFundLines, journalLinesAreBalanced, openingBalanceDuplicateMessage, operatingExpenseAccountKey, ownerFundAccountKey, postJournal,
} from "./accounting-posting";
import { calculateAccountingReports } from "../shared/accounting-reports";

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
  reversalEntryId: z.coerce.number().int().positive().optional(),
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
const openingBalanceReversalSchema = z.object({
  effectiveAt: dateQuery,
  reason: z.string().trim().min(3).max(450),
});
const OPENING_BALANCE_SOURCE_KEY = "opening-balances-v1";
const OPENING_BALANCE_REVERSAL_TYPE = "opening_balance_reversal";

export function registerAccountingRoutes(app: Express, owner: RequestHandler) {
  const ownerOnly: RequestHandler = (_req, res, next) => {
    if (res.locals.actor?.role !== "owner") {
      res.status(403).json({ error: "Only the business owner can correct opening balances." });
      return;
    }
    next();
  };

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
    if (input.reversalEntryId && res.locals.actor?.role !== "owner") {
      res.status(403).json({ error: "Only the business owner can replace reversed opening balances." });
      return;
    }
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
    let result: { alreadyExists: boolean };
    try {
      result = await db.transaction(async (tx) => {
        let sourceKey = OPENING_BALANCE_SOURCE_KEY;
        let sourceId: number | null = null;
        if (input.reversalEntryId) {
          const [reversal] = await tx.select().from(journalEntries)
            .where(and(
              eq(journalEntries.id, input.reversalEntryId),
              eq(journalEntries.sourceType, OPENING_BALANCE_REVERSAL_TYPE),
            )).for("update").limit(1);
          if (!reversal) return { alreadyExists: true };
          const [existingReplacement] = await tx.select().from(journalEntries)
            .where(and(
              eq(journalEntries.sourceType, "opening_balances"),
              eq(journalEntries.sourceId, reversal.id),
            )).limit(1);
          if (existingReplacement) return { alreadyExists: true };
          const [original] = await tx.select().from(journalEntries)
            .where(and(
              eq(journalEntries.id, reversal.sourceId!),
              eq(journalEntries.sourceType, "opening_balances"),
            )).limit(1);
          if (!original) return { alreadyExists: true };
          sourceKey = `opening-balance-replacement-${reversal.id}`;
          sourceId = reversal.id;
        } else {
          const [existing] = await tx.select().from(journalEntries)
            .where(eq(journalEntries.sourceType, "opening_balances")).limit(1);
          if (existing) return { alreadyExists: true };
        }

        const accountMap = await ensureAccountingAccounts(tx);
        if (lines.some((line) => !accountMap.has(line.accountKey))) {
          throw new Error("A required opening balance account is unavailable.");
        }
        const [entry] = await tx.insert(journalEntries).values({
          entryNumber: `JE-${input.effectiveAt.slice(0, 4)}-${randomUUID().slice(0, 8).toUpperCase()}`,
          sourceKey,
          sourceType: "opening_balances",
          sourceId,
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
    } catch (error) {
      const dbError = databaseErrorStatus(error, openingBalanceDuplicateMessage(Boolean(input.reversalEntryId)));
      if (dbError?.status === 409) {
        res.status(dbError.status).json({ error: dbError.message });
        return;
      }
      throw error;
    }
    if (result.alreadyExists) {
      res.status(409).json({ error: openingBalanceDuplicateMessage(Boolean(input.reversalEntryId)) });
      return;
    }
    res.status(201).json({ message: input.reversalEntryId
      ? "Corrected opening balances recorded."
      : "Opening balances recorded." });
  });

  app.post("/api/accounting/opening-balances/:entryId/reverse", owner, ownerOnly, async (req, res) => {
    const entryId = Number(req.params.entryId);
    const parsed = openingBalanceReversalSchema.safeParse(req.body);
    if (!Number.isSafeInteger(entryId) || entryId < 1 || !parsed.success) {
      res.status(400).json({ error: parsed.success
        ? "Choose a valid opening-balance entry."
        : parsed.error.issues[0]?.message ?? "Check the reversal details." });
      return;
    }
    const input = parsed.data;
    try {
      const result = await db.transaction(async (tx) => {
        const [original] = await tx.select().from(journalEntries)
          .where(and(
            eq(journalEntries.id, entryId),
            eq(journalEntries.sourceType, "opening_balances"),
          )).for("update").limit(1);
        if (!original) return { conflict: "Only an opening-balance entry can be reversed." };
        const [existingReversal] = await tx.select().from(journalEntries)
          .where(and(
            eq(journalEntries.sourceType, OPENING_BALANCE_REVERSAL_TYPE),
            eq(journalEntries.sourceId, original.id),
          )).limit(1);
        if (existingReversal) return { conflict: "This opening-balance entry has already been reversed." };

        const originalLines = await tx.select({
          accountKey: accountingAccounts.systemKey,
          productId: journalLines.productId,
          debitZmw: journalLines.debitZmw,
          creditZmw: journalLines.creditZmw,
          description: journalLines.description,
        }).from(journalLines)
          .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
          .where(eq(journalLines.journalEntryId, original.id));
        if (!originalLines.length || originalLines.some((line) => !line.accountKey)) {
          throw new Error("The opening-balance entry contains an unavailable account.");
        }
        const reversalLines = reversePostingLines(originalLines.map((line) => ({
          accountKey: line.accountKey!,
          productId: line.productId,
          debitZmw: line.debitZmw,
          creditZmw: line.creditZmw,
          description: line.description,
        })));
        const reversal = await postJournal(tx, {
          sourceKey: `opening-balance-reversal-${original.id}`,
          sourceType: OPENING_BALANCE_REVERSAL_TYPE,
          sourceId: original.id,
          entryDate: input.effectiveAt,
          memo: `Reversal of ${original.entryNumber}: ${input.reason}`,
          lines: reversalLines,
        });
        await recordBusinessAudit(tx, {
          entityType: "journal_entry", entityId: reversal.id, recordLabel: reversal.entryNumber,
          actor: res.locals.actor, action: "created",
          changedFields: ["entryDate", "memo", "reversesEntryId", "reason"],
        });
        return { conflict: null };
      });
      if (result.conflict) {
        res.status(409).json({ error: result.conflict });
        return;
      }
    } catch (error) {
      const dbError = databaseErrorStatus(error, "This opening-balance entry has already been reversed.");
      if (dbError?.status === 409) {
        res.status(dbError.status).json({ error: dbError.message });
        return;
      }
      throw error;
    }
    res.status(201).json({ message: "Opening balances reversed. You can now record the corrected balances." });
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
        id: journalEntries.id,
        entryDate: journalEntries.entryDate,
        entryNumber: journalEntries.entryNumber,
        memo: journalEntries.memo,
        sourceType: journalEntries.sourceType,
        sourceId: journalEntries.sourceId,
      }).from(journalEntries)
        .where(eq(journalEntries.sourceKey, OPENING_BALANCE_SOURCE_KEY)).limit(1);
      const openingHistoryRows = await tx.select({
        id: journalEntries.id,
        entryDate: journalEntries.entryDate,
        entryNumber: journalEntries.entryNumber,
        memo: journalEntries.memo,
        sourceType: journalEntries.sourceType,
        sourceId: journalEntries.sourceId,
      }).from(journalEntries)
        .where(inArray(journalEntries.sourceType, ["opening_balances", OPENING_BALANCE_REVERSAL_TYPE]))
        .orderBy(journalEntries.entryDate, journalEntries.id);
      const openingEntries = openingHistoryRows.filter((entry) => entry.sourceType === "opening_balances");
      const reversalEntries = openingHistoryRows.filter((entry) => entry.sourceType === OPENING_BALANCE_REVERSAL_TYPE);
      const reversedEntryIds = new Set(reversalEntries.map((entry) => entry.sourceId));
      const activeOpeningEntry = openingEntries.find((entry) => !reversedEntryIds.has(entry.id));
      const replacementReversal = [...reversalEntries].reverse().find((reversal) =>
        !openingEntries.some((entry) => entry.sourceId === reversal.id));
      const openingBalanceHistory = openingHistoryRows.map((entry) => {
        const isReversal = entry.sourceType === OPENING_BALANCE_REVERSAL_TYPE;
        const linkedReversal = isReversal
          ? null
          : reversalEntries.find((reversal) => reversal.sourceId === entry.id);
        return {
          id: entry.id,
          entryDate: entry.entryDate,
          entryNumber: entry.entryNumber,
          memo: entry.memo,
          kind: isReversal ? "reversal" as const : entry.sourceId ? "replacement" as const : "opening_balance" as const,
          relatedEntryId: entry.sourceId,
          reversalEntryId: linkedReversal?.id ?? null,
          reversed: Boolean(linkedReversal),
        };
      });
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

      const entryMap = new Map<number, {
         id: number; entryNumber: string; memo: string; entryDate: string; sourceType: string; sourceId: number | null;
        lines: Array<{ accountCode: string; accountName: string; debitZmw: string; creditZmw: string; description: string | null }>;
      }>();
      for (const row of records) {
        if (row.entry.entryDate >= from && !entryMap.has(row.entry.id)) {
          entryMap.set(row.entry.id, {
            id: row.entry.id, entryNumber: row.entry.entryNumber, memo: row.entry.memo,
            entryDate: row.entry.entryDate, sourceType: row.entry.sourceType, sourceId: row.entry.sourceId, lines: [],
          });
        }
        const entry = entryMap.get(row.entry.id);
        if (entry) entry.lines.push({
          accountCode: row.accountCode, accountName: row.accountName,
          debitZmw: row.line.debitZmw, creditZmw: row.line.creditZmw, description: row.line.description,
        });
      }
      const reports = calculateAccountingReports(
        accounts,
        records.map((row) => ({
          accountId: row.accountId,
          entryDate: row.entry.entryDate,
          debitZmw: row.line.debitZmw,
          creditZmw: row.line.creditZmw,
        })),
        from,
        to,
      );
      return {
        accounts,
        openingBalances: {
          posted: Boolean(activeOpeningEntry),
          entryDate: activeOpeningEntry?.entryDate ?? openingBalanceEntry?.entryDate ?? null,
          activeEntryId: activeOpeningEntry?.id ?? null,
          replacementReversalId: activeOpeningEntry ? null : replacementReversal?.id ?? null,
          canCorrect: res.locals.actor?.role === "owner",
          history: openingBalanceHistory,
        },
        expenses,
        ownerTransactions,
        entries: [...entryMap.values()],
        ...reports,
        from, to,
      };
    });
    res.json(result);
  });
}
