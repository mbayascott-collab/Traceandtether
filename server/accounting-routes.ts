import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  accountingAccounts, accountingCorrections, businessExpenses, importExpenses, inventoryMovements, journalEntries, journalLines,
  ownerFundTransactions, purchaseOrderLines, purchaseOrders, shipmentLines, shipmentPurchaseOrders, shipments,
} from "../shared/schema";
import { db } from "./db";
import { recordBusinessAudit } from "./audit";
import { databaseErrorStatus } from "./database-errors";
import {
  buildOpeningBalanceLines, cashAccountKeyForMethod, ensureAccountingAccounts, reversePostingLines,
  buildOwnerFundLines, journalLinesAreBalanced, openingBalanceDuplicateMessage, operatingExpenseAccountKey, ownerFundAccountKey, postJournal,
} from "./accounting-posting";
import { calculateAccountingReports, findExpenseJournalWarnings } from "../shared/accounting-reports";

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
const ownerFundCreateSchema = cashInSchema.extend({
  idempotencyKey: z.string().trim().min(8).max(80),
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
const expenseCorrectionSchema = expenseSchema.extend({
  idempotencyKey: z.string().trim().min(8).max(80),
  reason: z.string().trim().min(3).max(450),
});
const ownerFundCorrectionSchema = cashInSchema.extend({
  idempotencyKey: z.string().trim().min(8).max(80),
  reason: z.string().trim().min(3).max(450),
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

async function activeCorrection(tx: any, recordType: string, recordId: number) {
  const [correction] = await tx.select().from(accountingCorrections)
    .where(and(
      eq(accountingCorrections.recordType, recordType),
      eq(accountingCorrections.recordId, recordId),
    ))
    .orderBy(desc(accountingCorrections.id))
    .limit(1);
  return correction ?? null;
}

async function findCorrectionReplay(
  tx: any,
  input: {
    idempotencyKey: string;
    recordType: "business_expense" | "owner_fund_transaction";
    recordId: number;
    category: string | null;
    kind: string | null;
    description: string | null;
    amountZmw: string;
    effectiveDate: string;
    method: "cash" | "bank_transfer" | "mobile_money" | "other";
    reference: string | null;
    notes: string | null;
    reason: string;
  },
) {
  const [correction] = await tx.select().from(accountingCorrections)
    .where(eq(accountingCorrections.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (!correction) return null;
  const matches = correction.recordType === input.recordType &&
    correction.recordId === input.recordId &&
    correction.category === input.category &&
    correction.kind === input.kind &&
    correction.description === input.description &&
    cents(correction.amountZmw) === cents(input.amountZmw) &&
    correction.effectiveDate === input.effectiveDate &&
    correction.method === input.method &&
    correction.reference === input.reference &&
    correction.notes === input.notes &&
    correction.reason === input.reason;
  if (!matches) return { error: "This save key was already used for different correction details." };
  if (!correction.reversalEntryId || !correction.replacementEntryId) {
    throw new Error("The saved correction is missing its linked journal entries.");
  }
  const [reversal] = await tx.select().from(journalEntries)
    .where(eq(journalEntries.id, correction.reversalEntryId)).limit(1);
  const [replacement] = await tx.select().from(journalEntries)
    .where(eq(journalEntries.id, correction.replacementEntryId)).limit(1);
  if (!reversal || !replacement) {
    throw new Error("The saved correction's linked journal entries could not be found.");
  }
  return { correction: { ...correction, reversalEntryId: reversal.id, replacementEntryId: replacement.id }, reversal, replacement };
}

async function lockCorrectionSubmission(tx: any, idempotencyKey: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(0, hashtext(${"accounting-correction:" + idempotencyKey}))`);
}

function accountNameForOwnerKind(kind: string, accounts: Array<{ systemKey: string | null; name: string }>) {
  if (!["owner_contribution", "business_loan", "owner_withdrawal"].includes(kind)) return null;
  const systemKey = ownerFundAccountKey(kind as "owner_contribution" | "business_loan" | "owner_withdrawal");
  return accounts.find((account) => account.systemKey === systemKey)?.name ?? null;
}

async function postAccountingCorrection(tx: any, actor: any, input: {
  recordType: "business_expense" | "owner_fund_transaction";
  recordId: number;
  idempotencyKey: string;
  sourceKey: string;
  previousCorrection: typeof accountingCorrections.$inferSelect | null;
  category: string | null;
  kind: string | null;
  description: string | null;
  amountZmw: string;
  effectiveDate: string;
  method: "cash" | "bank_transfer" | "mobile_money" | "other";
  reference: string | null;
  notes: string | null;
  reason: string;
}) {
  const currentJournalId = input.previousCorrection?.replacementEntryId;
  const [currentJournal] = await tx.select().from(journalEntries)
    .where(currentJournalId
      ? eq(journalEntries.id, currentJournalId)
      : eq(journalEntries.sourceKey, input.sourceKey))
    .for("update")
    .limit(1);
  if (!currentJournal) throw new Error("The original journal entry for this record could not be found.");

  const currentLines = await tx.select({
    accountKey: accountingAccounts.systemKey,
    productId: journalLines.productId,
    debitZmw: journalLines.debitZmw,
    creditZmw: journalLines.creditZmw,
    description: journalLines.description,
  }).from(journalLines)
    .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
    .where(eq(journalLines.journalEntryId, currentJournal.id));
  if (!currentLines.length || currentLines.some((line: { accountKey: string | null }) => !line.accountKey)) {
    throw new Error("The current journal entry contains an unavailable account.");
  }
  const accountMap = await ensureAccountingAccounts(tx);
  const [correction] = await tx.insert(accountingCorrections).values({
    recordType: input.recordType,
    recordId: input.recordId,
    idempotencyKey: input.idempotencyKey,
    previousCorrectionId: input.previousCorrection?.id ?? null,
    category: input.category,
    kind: input.kind,
    description: input.description,
    amountZmw: input.amountZmw,
    effectiveDate: input.effectiveDate,
    method: input.method,
    reference: input.reference,
    notes: input.notes,
    reason: input.reason,
  }).returning();
  const reversal = await postJournal(tx, {
    sourceKey: `accounting-correction-${correction.id}-reversal`,
    sourceType: "accounting_correction_reversal",
    sourceId: correction.id,
    entryDate: input.effectiveDate,
    memo: `Correction reversal for ${input.recordType.replaceAll("_", " ")} ${input.recordId}: ${input.reason}`,
    lines: reversePostingLines(currentLines.map((line: any) => ({
      accountKey: line.accountKey!,
      productId: line.productId,
      debitZmw: line.debitZmw,
      creditZmw: line.creditZmw,
      description: line.description,
    }))),
  });

  let replacementLines;
  let replacementMemo: string;
  if (input.recordType === "business_expense") {
    const expenseAccountKey = operatingExpenseAccountKey(input.category ?? "other");
    const cashKey = cashAccountKeyForMethod(input.method);
    const expenseAccount = accountMap.get(expenseAccountKey);
    const cashAccount = accountMap.get(cashKey);
    if (!expenseAccount || !cashAccount) throw new Error("A required expense account is unavailable.");
    replacementMemo = `${expenseAccount.name}: ${input.description ?? "Corrected expense"}${input.reference ? ` · ${input.reference}` : ""}`;
    replacementLines = [
      { accountKey: expenseAccountKey, debitZmw: input.amountZmw, description: input.notes || input.description },
      { accountKey: cashKey, creditZmw: input.amountZmw, description: `Paid by ${input.method}` },
    ];
  } else {
    const kind = input.kind as "owner_contribution" | "business_loan" | "owner_withdrawal";
    const cashAccount = accountMap.get(cashAccountKeyForMethod(input.method));
    if (!cashAccount || !kind) throw new Error("A required owner-fund account is unavailable.");
    replacementLines = buildOwnerFundLines(kind, input.method, input.amountZmw, cashAccount.name, input.notes ?? undefined);
    replacementMemo = `${kind === "owner_contribution" ? "Owner contribution" : kind === "business_loan" ? "Business loan received" : "Owner withdrawal"}${input.reference ? ` · ${input.reference}` : ""}`;
  }
  const replacement = await postJournal(tx, {
    sourceKey: `accounting-correction-${correction.id}-replacement`,
    sourceType: "accounting_correction",
    sourceId: correction.id,
    entryDate: input.effectiveDate,
    memo: replacementMemo,
    lines: replacementLines,
  });
  await tx.update(accountingCorrections).set({
    reversalEntryId: reversal.id,
    replacementEntryId: replacement.id,
  }).where(eq(accountingCorrections.id, correction.id));
  await recordBusinessAudit(tx, {
    entityType: "accounting_correction",
    entityId: correction.id,
    recordLabel: `${input.recordType.replaceAll("_", " ")} ${input.recordId}`,
    actor,
    action: "created",
    changedFields: [
      "amountZmw", "effectiveDate", "category", "kind", "method", "reference", "notes",
      `reason: ${input.reason}`,
    ],
  });
  return {
    correction: { ...correction, reversalEntryId: reversal.id, replacementEntryId: replacement.id },
    reversal,
    replacement,
  };
}

export function registerAccountingRoutes(app: Express, owner: RequestHandler) {
  const ownerOnly: RequestHandler = (_req, res, next) => {
    if (res.locals.actor?.role !== "owner") {
      res.status(403).json({ error: "Only the business owner can correct accounting records." });
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

  app.post("/api/accounting/expenses/:expenseId/correct", owner, ownerOnly, async (req, res) => {
    const expenseId = Number(req.params.expenseId);
    const parsed = expenseCorrectionSchema.safeParse(req.body);
    if (!Number.isSafeInteger(expenseId) || expenseId < 1 || !parsed.success) {
      res.status(400).json({ error: parsed.success
        ? "Choose a valid expense."
        : parsed.error.issues[0]?.message ?? "Check the correction details." });
      return;
    }
    const input = parsed.data;
    if (cents(input.amountZmw) <= 0n) {
      res.status(400).json({ error: "Enter an expense amount greater than zero." });
      return;
    }
    const result: any = await db.transaction(async (tx) => {
      await lockCorrectionSubmission(tx, input.idempotencyKey);
      const [expense] = await tx.select().from(businessExpenses)
        .where(eq(businessExpenses.id, expenseId)).for("update").limit(1);
      if (!expense) return null;
      const replay = await findCorrectionReplay(tx, {
        idempotencyKey: input.idempotencyKey,
        recordType: "business_expense",
        recordId: expense.id,
        category: input.category,
        kind: null,
        description: input.description,
        amountZmw: input.amountZmw,
        effectiveDate: input.expenseDate,
        method: input.method,
        reference: input.reference || null,
        notes: input.notes || null,
        reason: input.reason,
      });
      if (replay) return "error" in replay ? replay : { ...replay, duplicate: true };
      const previousCorrection = await activeCorrection(tx, "business_expense", expense.id);
      const correction = await postAccountingCorrection(tx, res.locals.actor, {
        recordType: "business_expense",
        recordId: expense.id,
        idempotencyKey: input.idempotencyKey,
        sourceKey: `business-expense-${expense.id}`,
        previousCorrection,
        category: input.category,
        kind: null,
        description: input.description,
        amountZmw: input.amountZmw,
        effectiveDate: input.expenseDate,
        method: input.method,
        reference: input.reference || null,
        notes: input.notes || null,
        reason: input.reason,
      });
      return { ...correction, duplicate: false };
    });
    if (result && "error" in result) {
      res.status(409).json({ error: result.error });
      return;
    }
    if (!result) {
      res.status(404).json({ error: "That expense could not be found." });
      return;
    }
    const { duplicate, ...payload } = result;
    res.status(duplicate ? 200 : 201).json(payload);
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
    const parsed = ownerFundCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the cash-in details." });
      return;
    }
    const input = parsed.data;
    const requestMatches = (transaction: typeof ownerFundTransactions.$inferSelect) =>
      transaction.kind === input.kind
      && cents(transaction.amountZmw) === cents(input.amountZmw)
      && transaction.transactionDate === input.receivedAt
      && transaction.method === input.method
      && (transaction.reference ?? "") === input.reference
      && (transaction.notes ?? "") === input.notes;
    let amount: bigint;
    try { amount = cents(input.amountZmw); } catch { amount = 0n; }
    if (amount <= 0n) {
      res.status(400).json({ error: "Enter an amount greater than zero." });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(ownerFundTransactions)
        .where(eq(ownerFundTransactions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) {
        if (!requestMatches(existing)) {
          return { error: "This save key was already used for different owner-fund details.", status: 409 as const };
        }
        const [journal] = await tx.select().from(journalEntries)
          .where(eq(journalEntries.sourceKey, `owner-fund-${existing.id}`)).limit(1);
        if (!journal) throw new Error("The journal entry for this owner-fund transaction could not be found.");
        return { transaction: existing, journal, duplicate: true };
      }

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
        idempotencyKey: input.idempotencyKey,
      }).onConflictDoNothing({ target: ownerFundTransactions.idempotencyKey }).returning();
      if (!transaction) {
        const [concurrent] = await tx.select().from(ownerFundTransactions)
          .where(eq(ownerFundTransactions.idempotencyKey, input.idempotencyKey)).limit(1);
        if (!concurrent) throw new Error("The owner-fund transaction could not be recorded.");
        if (!requestMatches(concurrent)) {
          return { error: "This save key was already used for different owner-fund details.", status: 409 as const };
        }
        const [journal] = await tx.select().from(journalEntries)
          .where(eq(journalEntries.sourceKey, `owner-fund-${concurrent.id}`)).limit(1);
        if (!journal) throw new Error("The journal entry for this owner-fund transaction could not be found.");
        return { transaction: concurrent, journal, duplicate: true };
      }
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
      return { transaction, journal, duplicate: false };
    });
    if ("error" in result) {
      res.status(result.status ?? 409).json({ error: result.error });
      return;
    }
    res.status(result.duplicate ? 200 : 201).json({ transaction: result.transaction, journal: result.journal });
  });

  app.post("/api/accounting/funds/:transactionId/correct", owner, ownerOnly, async (req, res) => {
    const transactionId = Number(req.params.transactionId);
    const parsed = ownerFundCorrectionSchema.safeParse(req.body);
    if (!Number.isSafeInteger(transactionId) || transactionId < 1 || !parsed.success) {
      res.status(400).json({ error: parsed.success
        ? "Choose a valid owner-fund transaction."
        : parsed.error.issues[0]?.message ?? "Check the correction details." });
      return;
    }
    const input = parsed.data;
    if (cents(input.amountZmw) <= 0n) {
      res.status(400).json({ error: "Enter an amount greater than zero." });
      return;
    }
    const result: any = await db.transaction(async (tx) => {
      await lockCorrectionSubmission(tx, input.idempotencyKey);
      const [transaction] = await tx.select().from(ownerFundTransactions)
        .where(eq(ownerFundTransactions.id, transactionId)).for("update").limit(1);
      if (!transaction) return null;
      const replay = await findCorrectionReplay(tx, {
        idempotencyKey: input.idempotencyKey,
        recordType: "owner_fund_transaction",
        recordId: transaction.id,
        category: null,
        kind: input.kind,
        description: null,
        amountZmw: input.amountZmw,
        effectiveDate: input.receivedAt,
        method: input.method,
        reference: input.reference || null,
        notes: input.notes || null,
        reason: input.reason,
      });
      if (replay) return "error" in replay ? replay : { ...replay, duplicate: true };
      const previousCorrection = await activeCorrection(tx, "owner_fund_transaction", transaction.id);
      const correction = await postAccountingCorrection(tx, res.locals.actor, {
        recordType: "owner_fund_transaction",
        recordId: transaction.id,
        idempotencyKey: input.idempotencyKey,
        sourceKey: `owner-fund-${transaction.id}`,
        previousCorrection,
        category: null,
        kind: input.kind,
        description: null,
        amountZmw: input.amountZmw,
        effectiveDate: input.receivedAt,
        method: input.method,
        reference: input.reference || null,
        notes: input.notes || null,
        reason: input.reason,
      });
      return { ...correction, duplicate: false };
    });
    if (result && "error" in result) {
      res.status(409).json({ error: result.error });
      return;
    }
    if (!result) {
      res.status(404).json({ error: "That owner-fund transaction could not be found." });
      return;
    }
    const { duplicate, ...payload } = result;
    res.status(duplicate ? 200 : 201).json(payload);
  });

  app.get("/api/accounting", owner, async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const year = today.slice(0, 4);
    const from = String(req.query.from ?? `${year}-01-01`);
    const to = String(req.query.to ?? today);
    const readReference = (key: string) => {
      const raw = req.query[key];
      if (raw === undefined) return "";
      return typeof raw === "string" && raw.length <= 120 ? raw.trim() : null;
    };
    const purchaseOrderReference = readReference("purchaseOrder");
    const shipmentReference = readReference("shipment");
    if (purchaseOrderReference === null || shipmentReference === null) {
      res.status(400).json({ error: "Enter one purchase order or shipment reference at a time." });
      return;
    }
    if (purchaseOrderReference && shipmentReference) {
      res.status(400).json({ error: "Filter by a purchase order or a shipment, not both." });
      return;
    }
    if (!dateQuery.safeParse(from).success || !dateQuery.safeParse(to).success || from > to) {
      res.status(400).json({ error: "Choose a valid start and end date." });
      return;
    }

    const result = await db.transaction(async (tx) => {
      await ensureAccountingAccounts(tx);
      const accounts = await tx.select().from(accountingAccounts).orderBy(accountingAccounts.code);
      let journalEntryFilterIds: Set<number> | null = null;
      if (purchaseOrderReference || shipmentReference) {
        const purchaseOrderRows = purchaseOrderReference
          ? await tx.select({ id: purchaseOrders.id }).from(purchaseOrders)
            .where(eq(purchaseOrders.orderNumber, purchaseOrderReference))
          : [];
        let purchaseOrderIds: number[] | null = purchaseOrderReference
          ? purchaseOrderRows.map((row) => row.id)
          : null;
        const shipmentRows = shipmentReference
          ? await tx.select({ id: shipments.id }).from(shipments)
            .where(eq(shipments.shipmentReference, shipmentReference))
          : [];
        let shipmentIds: number[] | null = shipmentReference
          ? shipmentRows.map((row) => row.id)
          : null;

        if (shipmentIds !== null) {
          const linkedOrderRows = shipmentIds.length
            ? await tx.select({ purchaseOrderId: shipmentPurchaseOrders.purchaseOrderId })
              .from(shipmentPurchaseOrders).where(inArray(shipmentPurchaseOrders.shipmentId, shipmentIds))
            : [];
          const legacyOrderRows = shipmentIds.length
            ? await tx.select({ purchaseOrderId: shipments.purchaseOrderId }).from(shipments)
              .where(inArray(shipments.id, shipmentIds))
            : [];
          const linkedOrderIds = [...new Set([
            ...linkedOrderRows.map((row) => row.purchaseOrderId),
            ...legacyOrderRows.map((row) => row.purchaseOrderId),
          ])];
          purchaseOrderIds = purchaseOrderIds === null
            ? linkedOrderIds
            : purchaseOrderIds.filter((id) => linkedOrderIds.includes(id));
        }

        if (purchaseOrderIds !== null) {
          const linkedShipmentRows = purchaseOrderIds.length
            ? await tx.select({ shipmentId: shipmentPurchaseOrders.shipmentId })
              .from(shipmentPurchaseOrders).where(inArray(shipmentPurchaseOrders.purchaseOrderId, purchaseOrderIds))
            : [];
          const legacyShipmentRows = purchaseOrderIds.length
            ? await tx.select({ id: shipments.id }).from(shipments)
              .where(inArray(shipments.purchaseOrderId, purchaseOrderIds))
            : [];
          const linkedShipmentIds = [...new Set([
            ...linkedShipmentRows.map((row) => row.shipmentId),
            ...legacyShipmentRows.map((row) => row.id),
          ])];
          shipmentIds = shipmentIds === null
            ? linkedShipmentIds
            : shipmentIds.filter((id) => linkedShipmentIds.includes(id));
        }

        const linePredicates = [];
        if (purchaseOrderIds?.length) linePredicates.push(inArray(purchaseOrderLines.purchaseOrderId, purchaseOrderIds));
        if (shipmentIds?.length) linePredicates.push(inArray(shipmentLines.shipmentId, shipmentIds));
        const relatedLineRows = linePredicates.length
          ? await tx.select({ id: shipmentLines.id }).from(shipmentLines)
            .innerJoin(purchaseOrderLines, eq(shipmentLines.purchaseOrderLineId, purchaseOrderLines.id))
            .where(or(...linePredicates))
          : [];
        const relatedLineIds = new Set(relatedLineRows.map((row) => row.id));
        const expensePredicates = [];
        if (purchaseOrderIds?.length) expensePredicates.push(inArray(importExpenses.purchaseOrderId, purchaseOrderIds));
        if (shipmentIds?.length) expensePredicates.push(inArray(importExpenses.shipmentId, shipmentIds));
        const relatedExpenseRows = expensePredicates.length
          ? await tx.select({ id: importExpenses.id }).from(importExpenses).where(or(...expensePredicates))
          : [];
        const relatedJournalIds = new Set<number>();
        if (purchaseOrderIds?.length) {
          const adjustmentRows = await tx.select({ id: journalEntries.id }).from(journalEntries).where(and(
            eq(journalEntries.sourceType, "landed_cost_adjustment"),
            inArray(journalEntries.sourceId, purchaseOrderIds),
          ));
          adjustmentRows.forEach((row) => relatedJournalIds.add(row.id));
        }
        if (relatedExpenseRows.length) {
          const expenseJournalRows = await tx.select({ id: journalEntries.id }).from(journalEntries).where(and(
            eq(journalEntries.sourceType, "import_expense"),
            inArray(journalEntries.sourceId, relatedExpenseRows.map((row) => row.id)),
          ));
          expenseJournalRows.forEach((row) => relatedJournalIds.add(row.id));
        }
        if (relatedLineIds.size) {
          const receiptJournalRows = await tx.select({
            id: journalEntries.id,
            shipmentLineId: journalEntries.shipmentLineId,
            movementSourceKey: inventoryMovements.sourceKey,
          }).from(journalEntries)
            .leftJoin(inventoryMovements, eq(journalEntries.sourceId, inventoryMovements.id))
            .where(eq(journalEntries.sourceType, "stock_receipt"));
          for (const row of receiptJournalRows) {
            const sourceKeyMatch = row.movementSourceKey?.match(/^shipment-line-(\d+)-to-\d+$/);
            const shipmentLineId = row.shipmentLineId ?? (sourceKeyMatch ? Number(sourceKeyMatch[1]) : null);
            if (shipmentLineId !== null && relatedLineIds.has(shipmentLineId)) relatedJournalIds.add(row.id);
          }
        }
        journalEntryFilterIds = relatedJournalIds;
      }
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
          active: entry.id === activeOpeningEntry?.id,
        };
      });
      const correctionRows = await tx.select({
        id: accountingCorrections.id,
        recordType: accountingCorrections.recordType,
        recordId: accountingCorrections.recordId,
        previousCorrectionId: accountingCorrections.previousCorrectionId,
        reversalEntryId: accountingCorrections.reversalEntryId,
        replacementEntryId: accountingCorrections.replacementEntryId,
        category: accountingCorrections.category,
        kind: accountingCorrections.kind,
        description: accountingCorrections.description,
        amountZmw: accountingCorrections.amountZmw,
        effectiveDate: accountingCorrections.effectiveDate,
        method: accountingCorrections.method,
        reference: accountingCorrections.reference,
        notes: accountingCorrections.notes,
        reason: accountingCorrections.reason,
      }).from(accountingCorrections)
        .orderBy(accountingCorrections.id);
      const latestCorrections = new Map<string, (typeof correctionRows)[number]>();
      const correctionCounts = new Map<string, number>();
      for (const correction of correctionRows) {
        const key = `${correction.recordType}:${correction.recordId}`;
        latestCorrections.set(key, correction);
        correctionCounts.set(key, (correctionCounts.get(key) ?? 0) + 1);
      }
      const expenseRecords = await tx.select().from(businessExpenses)
        .orderBy(desc(businessExpenses.expenseDate), desc(businessExpenses.id));
      const originalExpenseJournals = expenseRecords.length
        ? await tx.select({
          id: journalEntries.id,
          expenseId: journalEntries.sourceId,
        }).from(journalEntries).where(and(
          eq(journalEntries.sourceType, "business_expense"),
          inArray(journalEntries.sourceId, expenseRecords.map((expense) => expense.id)),
        ))
        : [];
      const originalJournalIdByExpense = new Map(
        originalExpenseJournals.map((entry) => [entry.expenseId, entry.id]),
      );
      const expenses = expenseRecords.flatMap((expense) => {
        const key = `business_expense:${expense.id}`;
        const correction = latestCorrections.get(key);
        const effectiveDate = correction?.effectiveDate ?? expense.expenseDate;
        if (effectiveDate < from || effectiveDate > to) return [];
        return [{
          ...expense,
          effective: {
            category: correction?.category ?? expense.category,
            description: correction?.description ?? expense.description,
            amountZmw: correction?.amountZmw ?? expense.amountZmw,
            expenseDate: effectiveDate,
            method: correction?.method ?? expense.method,
            reference: correction?.reference ?? expense.reference,
            notes: correction?.notes ?? expense.notes,
          },
          correctionCount: correctionCounts.get(key) ?? 0,
        }];
      });
      const ownerTransactionRecords = await tx.select({
        id: ownerFundTransactions.id,
        kind: ownerFundTransactions.kind,
        amountZmw: ownerFundTransactions.amountZmw,
        transactionDate: ownerFundTransactions.transactionDate,
        method: ownerFundTransactions.method,
        reference: ownerFundTransactions.reference,
        notes: ownerFundTransactions.notes,
        accountName: accountingAccounts.name,
      }).from(ownerFundTransactions)
        .innerJoin(accountingAccounts, eq(ownerFundTransactions.accountId, accountingAccounts.id))
        .orderBy(desc(ownerFundTransactions.transactionDate), desc(ownerFundTransactions.id));
      const ownerTransactions = ownerTransactionRecords.flatMap((transaction) => {
        const key = `owner_fund_transaction:${transaction.id}`;
        const correction = latestCorrections.get(key);
        const effectiveDate = correction?.effectiveDate ?? transaction.transactionDate;
        if (effectiveDate < from || effectiveDate > to) return [];
        const effectiveKind = correction?.kind ?? transaction.kind;
        const effectiveAccountName = accountNameForOwnerKind(effectiveKind, accounts);
        return [{
          ...transaction,
          effective: {
            kind: effectiveKind,
            amountZmw: correction?.amountZmw ?? transaction.amountZmw,
            transactionDate: effectiveDate,
            method: correction?.method ?? transaction.method,
            reference: correction?.reference ?? transaction.reference,
            notes: correction?.notes ?? transaction.notes,
            accountName: effectiveAccountName ?? transaction.accountName,
          },
          correctionCount: correctionCounts.get(key) ?? 0,
        }];
      });
      const records = await tx.select({
        entry: journalEntries,
        line: journalLines,
        accountName: accountingAccounts.name,
        accountCode: accountingAccounts.code,
        accountSystemKey: accountingAccounts.systemKey,
        accountId: journalLines.accountId,
      }).from(journalLines)
        .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
        .leftJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
        .where(lte(journalEntries.entryDate, to))
        .orderBy(desc(journalEntries.entryDate), desc(journalEntries.id));

      const entryMap = new Map<number, {
         id: number; entryNumber: string; memo: string; entryDate: string; sourceType: string; sourceId: number | null;
         lines: Array<{ accountCode: string; accountName: string; debitZmw: string; creditZmw: string; description: string | null }>;
      }>();
      for (const row of records) {
        if (row.entry.entryDate >= from &&
            (journalEntryFilterIds === null || journalEntryFilterIds.has(row.entry.id)) &&
            !entryMap.has(row.entry.id)) {
          entryMap.set(row.entry.id, {
            id: row.entry.id, entryNumber: row.entry.entryNumber, memo: row.entry.memo,
            entryDate: row.entry.entryDate, sourceType: row.entry.sourceType, sourceId: row.entry.sourceId, lines: [],
          });
        }
        const entry = entryMap.get(row.entry.id);
        if (entry) entry.lines.push({
          accountCode: row.accountCode ?? "Unknown", accountName: row.accountName ?? "Unknown account",
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
          entryId: row.entry.id,
          entryNumber: row.entry.entryNumber,
        })),
        from,
        to,
      );
      const journalSnapshots = new Map<number, {
        entryId: number;
        entryDate: string;
        lines: Array<{ accountKey: string | null; debitZmw: string; creditZmw: string }>;
      }>();
      for (const row of records) {
        const snapshot = journalSnapshots.get(row.entry.id) ?? {
          entryId: row.entry.id,
          entryDate: row.entry.entryDate,
          lines: [],
        };
        snapshot.lines.push({
          accountKey: row.accountSystemKey,
          debitZmw: row.line.debitZmw,
          creditZmw: row.line.creditZmw,
        });
        journalSnapshots.set(row.entry.id, snapshot);
      }
      const expenseJournalWarnings = findExpenseJournalWarnings(
        expenses.map((expense) => {
          const correction = latestCorrections.get(`business_expense:${expense.id}`);
          return {
            expenseId: expense.id,
            effectiveDate: expense.effective.expenseDate,
            amountZmw: expense.effective.amountZmw,
            expenseAccountKey: operatingExpenseAccountKey(expense.effective.category),
            cashAccountKey: cashAccountKeyForMethod(expense.effective.method as "cash" | "bank_transfer" | "mobile_money" | "other"),
            journalEntryId: correction
              ? correction.replacementEntryId
              : originalJournalIdByExpense.get(expense.id) ?? null,
          };
        }),
        [...journalSnapshots.values()],
      );
      const entryNumberById = new Map(records.map((row) => [row.entry.id, row.entry.entryNumber]));
      const correctionHistory = correctionRows
        .filter((correction) => correction.effectiveDate >= from && correction.effectiveDate <= to)
        .map((correction) => ({
          id: correction.id,
          recordType: correction.recordType,
          recordId: correction.recordId,
          previousCorrectionId: correction.previousCorrectionId,
          effectiveDate: correction.effectiveDate,
          amountZmw: correction.amountZmw,
          reason: correction.reason,
          reversalEntryId: correction.reversalEntryId,
          reversalEntryNumber: correction.reversalEntryId ? entryNumberById.get(correction.reversalEntryId) ?? null : null,
          replacementEntryId: correction.replacementEntryId,
          replacementEntryNumber: correction.replacementEntryId ? entryNumberById.get(correction.replacementEntryId) ?? null : null,
        }));
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
        expenseJournalWarnings,
        ownerTransactions,
        correctionHistory,
        canCorrectRecords: res.locals.actor?.role === "owner",
        entries: [...entryMap.values()],
        ...reports,
        from, to,
      };
    });
    res.json(result);
  });

  app.get("/api/accounting/journal-entries/:id", owner, ownerOnly, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: "Choose a valid journal entry." });
      return;
    }
    const rows = await db.select({
      entry: journalEntries,
      line: journalLines,
      accountName: accountingAccounts.name,
      accountCode: accountingAccounts.code,
    }).from(journalEntries)
      .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalEntries.id, id))
      .orderBy(journalLines.id);
    if (!rows.length) {
      res.status(404).json({ error: "That journal entry could not be found." });
      return;
    }
    const entry = rows[0].entry;
    res.json({
      entry: {
        id: entry.id,
        entryNumber: entry.entryNumber,
        memo: entry.memo,
        entryDate: entry.entryDate,
        sourceType: entry.sourceType,
        lines: rows.map(({ line, accountCode, accountName }) => ({
          accountCode,
          accountName,
          debitZmw: line.debitZmw,
          creditZmw: line.creditZmw,
          description: line.description,
        })),
      },
    });
  });
}
