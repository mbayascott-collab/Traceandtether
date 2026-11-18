import { and, desc, eq, gte, inArray, lte, ne, sql, sum } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  accountingAccounts, businessPayments, customers, importExpenses, inventoryMovements, journalEntries, journalLines, paymentStatementImportBatches, paymentStatementLines,
  paymentReminders, purchaseOrders, salesDeliveryLines, salesDeliveries, salesOrderLines, salesOrders, suppliers,
} from "../shared/schema";
import { effectivePaymentDueDate, paymentAging } from "../shared/payment-aging";
import { db } from "./db";
import { recordBusinessAudit } from "./audit";
import { cashAccountKeyForMethod, cents, ensureAccountingAccounts, formatCents, postJournal } from "./accounting-posting";
import { paymentInputSchema } from "./payment-validation";
import { sendPaymentReminderEmail } from "./payment-reminder-email";
import {
  findDuplicateStatementRows, normalizeStatementText, statementImportFingerprint,
  type StatementImportLine,
} from "./payment-statement-import";

const bad = (res: import("express").Response, message: string, status = 400) => res.status(status).json({ error: message });
const dueDateInputSchema = z.object({
  direction: z.enum(["customer_receipt", "supplier_payment"]),
  orderId: z.number().int().positive(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Enter a valid due date."),
});
const paymentReminderInputSchema = z.object({
  note: z.string().trim().max(1000).optional().default(""),
});
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const reconciliationRangeSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  from: z.string().refine(validDate, "Choose a valid start date."),
  to: z.string().refine(validDate, "Choose a valid end date."),
}).refine((value) => value.from <= value.to, "Start date must be on or before end date.");
const statementLinesSchema = z.object({
  accountId: z.number().int().positive(),
  from: z.string().refine(validDate, "Choose a valid start date."),
  to: z.string().refine(validDate, "Choose a valid end date."),
  lines: z.array(z.object({
    transactionDate: z.string().refine(validDate, "Enter a valid transaction date."),
    flow: z.enum(["in", "out"]),
    amountZmw: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/, "Enter a valid positive amount."),
    description: z.string().trim().max(240).optional().default(""),
    reference: z.string().trim().max(120).optional().default(""),
  })).min(1).max(500),
}).refine((value) => value.from <= value.to, "Start date must be on or before end date.")
  .refine((value) => value.lines.every((line) => line.transactionDate >= value.from && line.transactionDate <= value.to),
    "Every statement date must be within the selected date range.");
const statementImportPreviewSchema = z.object({
  accountId: z.number().int().positive(),
  fileName: z.string().trim().min(1).max(255),
  from: z.string().refine(validDate, "Choose a valid start date."),
  to: z.string().refine(validDate, "Choose a valid end date."),
  lines: statementLinesSchema.shape.lines,
}).refine((value) => value.from <= value.to, "Start date must be on or before end date.")
  .refine((value) => value.lines.every((line) => line.transactionDate >= value.from && line.transactionDate <= value.to),
    "Every statement date must be within the selected date range.");
const statementImportSchema = statementImportPreviewSchema.extend({
  includedIndexes: z.array(z.number().int().nonnegative()).min(1),
  allowDuplicateBatch: z.boolean(),
}).refine((value) => new Set(value.includedIndexes).size === value.includedIndexes.length,
  "Each selected statement row must appear only once.")
  .refine((value) => value.includedIndexes.every((index) => index < value.lines.length),
    "A selected statement row is not part of this file.");
const importBatchIdSchema = z.coerce.number().int().positive();
const reconciliationMatchSchema = z.object({
  lineId: z.number().int().positive(),
  paymentId: z.number().int().positive().nullable(),
});
const RECONCILIATION_ACCOUNT_KEYS = new Set(["cash_on_hand", "bank_account", "mobile_money", "other_funds"]);

function accountMethod(systemKey: string | null) {
  if (systemKey === "cash_on_hand") return "cash";
  if (systemKey === "bank_account") return "bank_transfer";
  if (systemKey === "mobile_money") return "mobile_money";
  if (systemKey === "other_funds") return "other";
  return null;
}

function normalizeReference(value: string | null | undefined) {
  return normalizeStatementText(value);
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "23505";
}

async function payableForPurchaseOrder(tx: any, orderId: number, orderNumber: string, knownAccounts?: Map<string, typeof accountingAccounts.$inferSelect>) {
  const accountsByKey = knownAccounts ?? await ensureAccountingAccounts(tx);
  const payableAccount = accountsByKey.get("accounts_payable");
  if (!payableAccount) return 0n;
  const [receiptRow] = await tx.select({ total: sum(journalLines.creditZmw) })
    .from(journalEntries)
    .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
    .where(and(
      eq(journalEntries.memo, `Stock receipt for ${orderNumber}`),
      eq(journalLines.accountId, payableAccount.id),
    ));
  const [importRow] = await tx.select({ total: sum(journalLines.creditZmw) })
    .from(journalEntries)
    .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(importExpenses, eq(journalEntries.sourceId, importExpenses.id))
    .where(and(
      eq(journalEntries.sourceType, "import_expense"),
      eq(importExpenses.purchaseOrderId, orderId),
      eq(journalLines.accountId, payableAccount.id),
    ));
  return cents(String(receiptRow?.total ?? "0.00")) + cents(String(importRow?.total ?? "0.00"));
}

function paymentMatchesRequest(payment: typeof businessPayments.$inferSelect, input: z.infer<typeof paymentInputSchema>) {
  return payment.idempotencyKey === input.idempotencyKey
    && payment.direction === input.direction
    && payment.salesOrderId === (input.direction === "customer_receipt" ? input.orderId : null)
    && payment.purchaseOrderId === (input.direction === "supplier_payment" ? input.orderId : null)
    && cents(payment.amountZmw) === cents(input.amountZmw)
    && payment.paymentDate === input.paymentDate
    && payment.method === input.method
    && (payment.reference ?? null) === (input.reference ?? null)
    && (payment.notes ?? null) === (input.notes ?? null);
}

export function registerPaymentRoutes(app: Express, owner: RequestHandler) {
  app.get("/api/payments/reconciliation/accounts", owner, async (_req, res) => {
    const accountsByKey = await ensureAccountingAccounts(db);
    res.json({
      accounts: [...accountsByKey.values()]
        .filter((account) => account.active && RECONCILIATION_ACCOUNT_KEYS.has(account.systemKey ?? ""))
        .sort((a, b) => a.code.localeCompare(b.code))
        .map(({ id, code, name, systemKey }) => ({ id, code, name, systemKey })),
    });
  });

  app.get("/api/payments/reconciliation", owner, async (req, res) => {
    const parsed = reconciliationRangeSchema.safeParse({
      accountId: req.query.accountId, from: req.query.from, to: req.query.to,
    });
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Choose an account and date range.");
    const { accountId, from, to } = parsed.data;
    const accountsByKey = await ensureAccountingAccounts(db);
    const account = [...accountsByKey.values()].find((item) => item.id === accountId && item.active);
    const method = accountMethod(account?.systemKey ?? null);
    if (!account || !method) return bad(res, "Choose an active cash, bank, mobile money, or other funds account.", 404);
    const rangeStart = new Date(`${from}T00:00:00.000Z`);
    const rangeEnd = new Date(`${to}T00:00:00.000Z`);
    rangeStart.setUTCDate(rangeStart.getUTCDate() - 7);
    rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 7);
    const paymentFrom = rangeStart.toISOString().slice(0, 10);
    const paymentTo = rangeEnd.toISOString().slice(0, 10);
    const [statementRows, paymentRows, allMatchedRows] = await Promise.all([
      db.select({
        line: paymentStatementLines,
        payment: businessPayments,
        orderNumber: sql<string | null>`coalesce(${salesOrders.orderNumber}, ${purchaseOrders.orderNumber})`,
        partyName: sql<string | null>`coalesce(${customers.name}, ${suppliers.name})`,
      }).from(paymentStatementLines)
        .leftJoin(businessPayments, eq(paymentStatementLines.matchedPaymentId, businessPayments.id))
        .leftJoin(salesOrders, eq(businessPayments.salesOrderId, salesOrders.id))
        .leftJoin(customers, eq(salesOrders.customerId, customers.id))
        .leftJoin(purchaseOrders, eq(businessPayments.purchaseOrderId, purchaseOrders.id))
        .leftJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
        .where(and(
          eq(paymentStatementLines.accountId, accountId),
          gte(paymentStatementLines.transactionDate, from),
          lte(paymentStatementLines.transactionDate, to),
        ))
        .orderBy(desc(paymentStatementLines.transactionDate), desc(paymentStatementLines.id)),
      db.select({
        payment: businessPayments, orderNumber: sql<string | null>`coalesce(${salesOrders.orderNumber}, ${purchaseOrders.orderNumber})`,
        partyName: sql<string | null>`coalesce(${customers.name}, ${suppliers.name})`,
      }).from(businessPayments)
        .leftJoin(salesOrders, eq(businessPayments.salesOrderId, salesOrders.id))
        .leftJoin(customers, eq(salesOrders.customerId, customers.id))
        .leftJoin(purchaseOrders, eq(businessPayments.purchaseOrderId, purchaseOrders.id))
        .leftJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
        .where(and(
          eq(businessPayments.method, method),
          gte(businessPayments.paymentDate, paymentFrom),
          lte(businessPayments.paymentDate, paymentTo),
        ))
        .orderBy(desc(businessPayments.paymentDate), desc(businessPayments.id)),
      db.select({ paymentId: paymentStatementLines.matchedPaymentId }).from(paymentStatementLines)
        .where(sql`${paymentStatementLines.matchedPaymentId} is not null`),
    ]);
    const importBatches = await db.select().from(paymentStatementImportBatches)
      .where(eq(paymentStatementImportBatches.accountId, accountId))
      .orderBy(desc(paymentStatementImportBatches.createdAt), desc(paymentStatementImportBatches.id));
    const lineKeys = new Map<string, number>();
    const lineCounts = new Map<number, number>();
    for (const { line } of statementRows) {
      const key = `${line.transactionDate}|${line.flow}|${line.amountZmw}|${normalizeReference(line.reference)}`;
      lineKeys.set(key, (lineKeys.get(key) ?? 0) + 1);
    }
    for (const { line } of statementRows) {
      const key = `${line.transactionDate}|${line.flow}|${line.amountZmw}|${normalizeReference(line.reference)}`;
      lineCounts.set(line.id, lineKeys.get(key) ?? 0);
    }
    const paymentKeys = new Map<string, number>();
    for (const { payment } of paymentRows) {
      const key = `${payment.paymentDate}|${payment.method}|${payment.amountZmw}|${normalizeReference(payment.reference)}`;
      paymentKeys.set(key, (paymentKeys.get(key) ?? 0) + 1);
    }
    const matchedIds = new Set(allMatchedRows.map(({ paymentId }) => paymentId).filter((id): id is number => id !== null));
    res.json({
      account: { id: account.id, code: account.code, name: account.name },
      lines: statementRows.map(({ line, payment, orderNumber, partyName }) => ({
        ...line,
        duplicateLike: (lineCounts.get(line.id) ?? 0) > 1,
        matchedPayment: payment ? {
          id: payment.id, paymentNumber: payment.paymentNumber, paymentDate: payment.paymentDate,
          amountZmw: payment.amountZmw, method: payment.method, direction: payment.direction,
          reference: payment.reference, orderNumber: orderNumber ?? "—", partyName: partyName ?? "—",
        } : null,
      })),
      payments: paymentRows.map(({ payment, orderNumber, partyName }) => ({
        ...payment,
        orderNumber: orderNumber ?? "—", partyName: partyName ?? "—",
        matched: matchedIds.has(payment.id),
        duplicateLike: (paymentKeys.get(`${payment.paymentDate}|${payment.method}|${payment.amountZmw}|${normalizeReference(payment.reference)}`) ?? 0) > 1,
      })),
      importBatches,
      from, to,
    });
  });

  app.post("/api/payments/reconciliation/imports/preview", owner, async (req, res) => {
    const parsed = statementImportPreviewSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the statement file.");
    const input = parsed.data;
    const accountsByKey = await ensureAccountingAccounts(db);
    const account = [...accountsByKey.values()].find((item) => item.id === input.accountId && item.active);
    if (!account || !RECONCILIATION_ACCOUNT_KEYS.has(account.systemKey ?? "")) {
      return bad(res, "Choose an active cash, bank, mobile money, or other funds account.", 404);
    }
    if (input.lines.some((line) => cents(line.amountZmw) <= 0n)) return bad(res, "Enter amounts greater than zero.");
    const lines = input.lines as StatementImportLine[];
    const fingerprint = statementImportFingerprint(lines);
    const [existingBatch, existingLines] = await Promise.all([
      db.select({
        id: paymentStatementImportBatches.id,
        fileName: paymentStatementImportBatches.fileName,
        createdAt: paymentStatementImportBatches.createdAt,
        lineCount: paymentStatementImportBatches.lineCount,
      }).from(paymentStatementImportBatches)
        .where(and(
          eq(paymentStatementImportBatches.accountId, input.accountId),
          eq(paymentStatementImportBatches.fingerprint, fingerprint),
        ))
        .orderBy(desc(paymentStatementImportBatches.createdAt))
        .limit(1),
      db.select({
        transactionDate: paymentStatementLines.transactionDate,
        flow: paymentStatementLines.flow,
        amountZmw: paymentStatementLines.amountZmw,
        reference: paymentStatementLines.reference,
      }).from(paymentStatementLines)
        .where(and(
          eq(paymentStatementLines.accountId, input.accountId),
          gte(paymentStatementLines.transactionDate, input.from),
          lte(paymentStatementLines.transactionDate, input.to),
        )),
    ]);
    res.json({
      duplicateBatch: existingBatch[0] ?? null,
      duplicateRows: findDuplicateStatementRows(lines, existingLines.map((line) => ({
        ...line, amountZmw: String(line.amountZmw), reference: line.reference ?? "",
      }))),
    });
  });

  app.post("/api/payments/reconciliation/imports", owner, async (req, res) => {
    const parsed = statementImportSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the statement file.");
    const input = parsed.data;
    const accountsByKey = await ensureAccountingAccounts(db);
    const account = [...accountsByKey.values()].find((item) => item.id === input.accountId && item.active);
    if (!account || !RECONCILIATION_ACCOUNT_KEYS.has(account.systemKey ?? "")) {
      return bad(res, "Choose an active cash, bank, mobile money, or other funds account.", 404);
    }
    if (input.lines.some((line) => cents(line.amountZmw) <= 0n)) return bad(res, "Enter amounts greater than zero.");
    const fingerprint = statementImportFingerprint(input.lines as StatementImportLine[]);
    const selectedLines = input.includedIndexes.map((index) => input.lines[index]);
    const inserted = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(0, hashtext(${`${input.accountId}:${fingerprint}`}))`);
      const matchingBatch = await tx.select({
        id: paymentStatementImportBatches.id,
        fileName: paymentStatementImportBatches.fileName,
        createdAt: paymentStatementImportBatches.createdAt,
        lineCount: paymentStatementImportBatches.lineCount,
      }).from(paymentStatementImportBatches)
        .where(and(
          eq(paymentStatementImportBatches.accountId, input.accountId),
          eq(paymentStatementImportBatches.fingerprint, fingerprint),
        ))
        .orderBy(desc(paymentStatementImportBatches.createdAt))
        .limit(1);
      if (matchingBatch.length && !input.allowDuplicateBatch) {
        return { duplicateBatch: matchingBatch[0] };
      }
      const [batch] = await tx.insert(paymentStatementImportBatches).values({
        accountId: input.accountId,
        fileName: input.fileName,
        fingerprint,
        lineCount: selectedLines.length,
      }).returning();
      const rows = await tx.insert(paymentStatementLines).values(selectedLines.map((line) => ({
        accountId: input.accountId,
        transactionDate: line.transactionDate,
        flow: line.flow,
        amountZmw: formatCents(cents(line.amountZmw)),
        description: line.description,
        reference: line.reference || null,
        importBatchId: batch.id,
      }))).returning();
      for (const line of rows) await recordBusinessAudit(tx, {
        entityType: "payment_statement_line", entityId: line.id,
        recordLabel: `Statement line #${line.id}`,
        actor: res.locals.actor, action: "created",
        changedFields: ["accountId", "transactionDate", "flow", "amountZmw", "description", "reference", "importBatchId"],
      });
      await recordBusinessAudit(tx, {
        entityType: "payment_statement_import_batch", entityId: batch.id,
        recordLabel: batch.fileName, actor: res.locals.actor, action: "created",
        changedFields: ["accountId", "fileName", "fingerprint", "lineCount"],
      });
      return { batch, added: rows.length };
    });
    if ("duplicateBatch" in inserted) {
      return res.status(409).json({ error: "This exact statement was already imported. Review it before importing again.", duplicateBatch: inserted.duplicateBatch });
    }
    res.status(201).json({ added: inserted.added, batch: inserted.batch });
  });

  app.delete("/api/payments/reconciliation/imports/:id", owner, async (req, res) => {
    const parsed = importBatchIdSchema.safeParse(req.params.id);
    if (!parsed.success) return bad(res, "Choose a valid statement import.");
    const batchId = parsed.data;
    const [batch] = await db.select().from(paymentStatementImportBatches)
      .where(eq(paymentStatementImportBatches.id, batchId)).limit(1);
    if (!batch) return bad(res, "Statement import not found.", 404);
    await db.transaction(async (tx) => {
      const lines = await tx.select({ id: paymentStatementLines.id })
        .from(paymentStatementLines).where(eq(paymentStatementLines.importBatchId, batchId));
      for (const line of lines) await recordBusinessAudit(tx, {
        entityType: "payment_statement_line", entityId: line.id,
        recordLabel: `Statement line #${line.id}`,
        actor: res.locals.actor, action: "deleted",
        changedFields: ["accountId", "transactionDate", "flow", "amountZmw", "description", "reference", "matchedPaymentId", "importBatchId"],
      });
      await recordBusinessAudit(tx, {
        entityType: "payment_statement_import_batch", entityId: batch.id,
        recordLabel: batch.fileName, actor: res.locals.actor, action: "deleted",
        changedFields: ["accountId", "fileName", "fingerprint", "lineCount"],
      });
      await tx.delete(paymentStatementImportBatches).where(eq(paymentStatementImportBatches.id, batchId));
    });
    res.json({ ok: true });
  });

  app.post("/api/payments/reconciliation/lines", owner, async (req, res) => {
    const parsed = statementLinesSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the statement lines.");
    const input = parsed.data;
    const accountsByKey = await ensureAccountingAccounts(db);
    const account = [...accountsByKey.values()].find((item) => item.id === input.accountId && item.active);
    if (!account || !RECONCILIATION_ACCOUNT_KEYS.has(account.systemKey ?? "")) {
      return bad(res, "Choose an active cash, bank, mobile money, or other funds account.", 404);
    }
    if (input.lines.some((line) => cents(line.amountZmw) <= 0n)) return bad(res, "Enter amounts greater than zero.");
    const inserted = await db.transaction(async (tx) => {
      const rows = await tx.insert(paymentStatementLines).values(input.lines.map((line) => ({
        accountId: input.accountId,
        transactionDate: line.transactionDate,
        flow: line.flow,
        amountZmw: formatCents(cents(line.amountZmw)),
        description: line.description,
        reference: line.reference || null,
      }))).returning();
      for (const line of rows) await recordBusinessAudit(tx, {
        entityType: "payment_statement_line", entityId: line.id,
        recordLabel: `Statement line #${line.id}`,
        actor: res.locals.actor, action: "created",
        changedFields: ["accountId", "transactionDate", "flow", "amountZmw", "description", "reference"],
      });
      return rows;
    });
    res.status(201).json({ added: inserted.length });
  });

  app.put("/api/payments/reconciliation/match", owner, async (req, res) => {
    const parsed = reconciliationMatchSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the match details.");
    const { lineId, paymentId } = parsed.data;
    const [line] = await db.select().from(paymentStatementLines).where(eq(paymentStatementLines.id, lineId)).limit(1);
    if (!line) return bad(res, "Statement line not found.", 404);
    if (paymentId === null) {
      await db.transaction(async (tx) => {
        await tx.update(paymentStatementLines).set({ matchedPaymentId: null }).where(eq(paymentStatementLines.id, lineId));
        await recordBusinessAudit(tx, {
          entityType: "payment_statement_line", entityId: line.id,
          recordLabel: `Statement line #${line.id}`,
          actor: res.locals.actor, action: "updated", changedFields: ["matchedPaymentId"],
        });
      });
      return res.json({ ok: true });
    }
    const accountsByKey = await ensureAccountingAccounts(db);
    const account = [...accountsByKey.values()].find((item) => item.id === line.accountId);
    const method = accountMethod(account?.systemKey ?? null);
    const [payment] = await db.select().from(businessPayments).where(eq(businessPayments.id, paymentId)).limit(1);
    if (!payment || !method || payment.method !== method) {
      return bad(res, "That payment does not use the selected cash, bank, or mobile money account.", 400);
    }
    try {
      await db.transaction(async (tx) => {
        await tx.update(paymentStatementLines).set({ matchedPaymentId: paymentId }).where(eq(paymentStatementLines.id, lineId));
        await recordBusinessAudit(tx, {
          entityType: "payment_statement_line", entityId: line.id,
          recordLabel: `Statement line #${line.id}`,
          actor: res.locals.actor, action: "updated", changedFields: ["matchedPaymentId"],
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) return bad(res, "That payment is already matched to another statement line.", 409);
      throw error;
    }
    res.json({ ok: true });
  });

  app.get("/api/payments", owner, async (_req, res) => {
    const accountMap = await ensureAccountingAccounts(db);
    const [paymentRows, eligibleOrders, orderLines, deliveryRows, openPurchaseOrders, returnRows] = await Promise.all([
      db.select({
        payment: businessPayments, salesOrderNumber: salesOrders.orderNumber, customerName: customers.name,
        purchaseOrderNumber: purchaseOrders.orderNumber, supplierName: suppliers.name,
      }).from(businessPayments)
        .leftJoin(salesOrders, eq(businessPayments.salesOrderId, salesOrders.id))
        .leftJoin(customers, eq(salesOrders.customerId, customers.id))
        .leftJoin(purchaseOrders, eq(businessPayments.purchaseOrderId, purchaseOrders.id))
        .leftJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
        .orderBy(desc(businessPayments.paymentDate), desc(businessPayments.createdAt)),
      db.select({
        order: salesOrders, customerName: customers.name, customerEmail: customers.email,
        customerPaymentTermDays: customers.paymentTermDays,
      }).from(salesOrders)
        .innerJoin(customers, eq(salesOrders.customerId, customers.id))
        .where(inArray(salesOrders.status, ["partially_fulfilled", "fulfilled", "cancelled"])),
      db.select().from(salesOrderLines),
      db.select({
        orderId: salesDeliveries.salesOrderId, deliveryDate: salesDeliveries.deliveryDate,
        quantity: salesDeliveryLines.quantity, unitPriceZmw: salesOrderLines.unitPriceZmw,
      }).from(salesDeliveryLines)
        .innerJoin(salesDeliveries, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
        .innerJoin(salesOrderLines, eq(salesDeliveryLines.salesOrderLineId, salesOrderLines.id)),
      db.select({
        order: purchaseOrders, supplierName: suppliers.name, supplierPaymentTermDays: suppliers.paymentTermDays,
      }).from(purchaseOrders)
        .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
        .where(ne(purchaseOrders.status, "cancelled")),
      db.select({
        orderId: salesDeliveries.salesOrderId,
        quantity: inventoryMovements.quantityDelta,
        unitPriceZmw: salesOrderLines.unitPriceZmw,
      }).from(inventoryMovements)
        .innerJoin(salesDeliveryLines, eq(inventoryMovements.salesDeliveryLineId, salesDeliveryLines.id))
        .innerJoin(salesDeliveries, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
        .innerJoin(salesOrderLines, eq(salesDeliveryLines.salesOrderLineId, salesOrderLines.id))
        .where(eq(inventoryMovements.kind, "stock_return")),
    ]);

    const payments = await db.select().from(businessPayments);
    const reminderRows = await db.select().from(paymentReminders)
      .orderBy(desc(paymentReminders.attemptedAt), desc(paymentReminders.id));
    const latestReminderByOrder = new Map<number, typeof paymentReminders.$inferSelect>();
    for (const reminder of reminderRows) {
      if (!latestReminderByOrder.has(reminder.salesOrderId)) latestReminderByOrder.set(reminder.salesOrderId, reminder);
    }
    const paidSales = new Map<number, bigint>();
    const paidPurchases = new Map<number, bigint>();
    for (const payment of payments) {
      const key = payment.direction === "customer_receipt" ? payment.salesOrderId : payment.purchaseOrderId;
      const target = payment.direction === "customer_receipt" ? paidSales : paidPurchases;
      if (key !== null) target.set(key, (target.get(key) ?? 0n) + cents(payment.amountZmw));
    }

    const deliveredTotals = new Map<number, bigint>();
    const returnedTotals = new Map<number, bigint>();
    const latestDeliveryDate = new Map<number, string>();
    for (const row of deliveryRows) {
      deliveredTotals.set(row.orderId, (deliveredTotals.get(row.orderId) ?? 0n) + cents(row.unitPriceZmw) * BigInt(row.quantity));
      const latest = latestDeliveryDate.get(row.orderId);
      if (!latest || row.deliveryDate > latest) latestDeliveryDate.set(row.orderId, row.deliveryDate);
    }
    for (const row of returnRows) {
      returnedTotals.set(row.orderId,
        (returnedTotals.get(row.orderId) ?? 0n) + cents(row.unitPriceZmw) * BigInt(row.quantity));
    }
    const ordersWithDelivery = new Set(deliveryRows.map((row) => row.orderId));
    const invoices = eligibleOrders.map(({ order, customerName, customerEmail, customerPaymentTermDays }) => {
      const total = ordersWithDelivery.has(order.id)
        ? deliveredTotals.get(order.id) ?? 0n
        : order.status === "fulfilled"
          ? orderLines.filter((line) => line.salesOrderId === order.id)
            .reduce((acc, line) => acc + cents(line.unitPriceZmw) * BigInt(line.quantity), 0n)
          : 0n;
      const netTotal = total - (returnedTotals.get(order.id) ?? 0n);
      const outstanding = netTotal - (paidSales.get(order.id) ?? 0n);
      const sourceDate = latestDeliveryDate.get(order.id) ?? order.orderDate;
      const dueDate = effectivePaymentDueDate(order.dueDate, sourceDate, customerPaymentTermDays);
      return {
        orderId: order.id, orderNumber: order.orderNumber, partyName: customerName, customerEmail,
        totalZmw: formatCents(netTotal), paidZmw: formatCents(paidSales.get(order.id) ?? 0n),
        outstandingZmw: formatCents(outstanding), dueDate,
        lastReminder: latestReminderByOrder.has(order.id) ? (() => {
          const reminder = latestReminderByOrder.get(order.id)!;
          return {
            status: reminder.status, attemptedAt: reminder.attemptedAt, sentAt: reminder.sentAt,
            recipientEmail: reminder.recipientEmail, error: reminder.sendError,
          };
        })() : null,
        ...paymentAging(dueDate, new Date().toISOString().slice(0, 10)),
      };
    }).filter((item) => cents(item.outstandingZmw) > 0n);

    const bills: Array<{
      orderId: number; orderNumber: string; partyName: string; totalZmw: string; paidZmw: string;
      outstandingZmw: string; dueDate: string; overdueDays: number; agingBucket: string;
    }> = [];
    for (const { order, supplierName, supplierPaymentTermDays } of openPurchaseOrders) {
      const total = await payableForPurchaseOrder(db, order.id, order.orderNumber, accountMap);
      const paid = paidPurchases.get(order.id) ?? 0n;
      const dueDate = effectivePaymentDueDate(order.dueDate, order.orderedAt, supplierPaymentTermDays);
      if (total > paid) bills.push({
        orderId: order.id, orderNumber: order.orderNumber, partyName: supplierName,
        totalZmw: formatCents(total), paidZmw: formatCents(paid), outstandingZmw: formatCents(total - paid),
        dueDate, ...paymentAging(dueDate, new Date().toISOString().slice(0, 10)),
      });
    }

    res.json({
      payments: paymentRows.map(({ payment, salesOrderNumber, customerName, purchaseOrderNumber, supplierName }) => ({
        ...payment, orderNumber: salesOrderNumber ?? purchaseOrderNumber ?? "—",
        partyName: customerName ?? supplierName ?? "—",
      })),
      invoices, bills,
    });
  });

  app.post("/api/payments/:orderId/reminder", owner, async (req, res) => {
    const orderId = z.coerce.number().int().positive().safeParse(req.params.orderId);
    if (!orderId.success) return bad(res, "Choose a valid customer order.");
    const parsed = paymentReminderInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the reminder message.");

    const today = new Date().toISOString().slice(0, 10);
    const claim = await db.transaction(async (tx) => {
      const [order] = await tx.select().from(salesOrders)
        .where(eq(salesOrders.id, orderId.data)).for("update").limit(1);
      if (!order) return { error: "Customer order not found.", status: 404 as const };

      const [customer] = await tx.select({
        name: customers.name, email: customers.email, paymentTermDays: customers.paymentTermDays,
      })
        .from(customers).where(eq(customers.id, order.customerId)).limit(1);
      if (!customer?.email) {
        return { error: "Add a saved email address to this customer before sending a reminder.", status: 400 as const };
      }
      if (!z.string().email().safeParse(customer.email).success) {
        return { error: "The customer's saved email address is invalid. Update it before sending a reminder.", status: 400 as const };
      }

      const deliveryRows = await tx.select({
        quantity: salesDeliveryLines.quantity, unitPriceZmw: salesOrderLines.unitPriceZmw,
        deliveryDate: salesDeliveries.deliveryDate,
      }).from(salesDeliveryLines)
        .innerJoin(salesDeliveries, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
        .innerJoin(salesOrderLines, eq(salesDeliveryLines.salesOrderLineId, salesOrderLines.id))
        .where(eq(salesDeliveries.salesOrderId, order.id));
      const deliveredTotal = deliveryRows.reduce(
        (total, line) => total + cents(line.unitPriceZmw) * BigInt(line.quantity), 0n,
      );
      const orderTotal = deliveryRows.length > 0
        ? deliveredTotal
        : order.status === "fulfilled"
          ? (await tx.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, order.id)))
            .reduce((total, line) => total + cents(line.unitPriceZmw) * BigInt(line.quantity), 0n)
          : 0n;
      const [paidRow] = await tx.select({ total: sum(businessPayments.amountZmw) })
        .from(businessPayments)
        .where(and(
          eq(businessPayments.direction, "customer_receipt"),
          eq(businessPayments.salesOrderId, order.id),
        ));
      const outstanding = orderTotal - cents(String(paidRow?.total ?? "0.00"));
      if (outstanding <= 0n) return { error: "This customer order has no amount left to pay.", status: 409 as const };

      const latestDeliveryDate = deliveryRows.reduce<string | null>(
        (latest, line) => !latest || line.deliveryDate > latest ? line.deliveryDate : latest,
        null,
      );
      const dueDate = effectivePaymentDueDate(
        order.dueDate, latestDeliveryDate ?? order.orderDate, customer.paymentTermDays,
      );
      if (dueDate >= today) {
        return { error: "This balance is not overdue. A reminder can only be sent after its due date.", status: 409 as const };
      }

      const [activeAttempt] = await tx.select().from(paymentReminders)
        .where(and(
          eq(paymentReminders.salesOrderId, order.id),
          eq(paymentReminders.status, "sending"),
        ))
        .orderBy(desc(paymentReminders.attemptedAt))
        .for("update")
        .limit(1);
      if (activeAttempt) {
        const isStale = Date.now() - activeAttempt.attemptedAt.getTime() > 5 * 60 * 1000;
        if (!isStale) {
          return { error: "A reminder is already being sent for this order. Wait for it to finish.", status: 409 as const };
        }
        const staleError = "The previous send did not finish. Check Gmail Sent before trying again.";
        const [failedAttempt] = await tx.update(paymentReminders).set({
          status: "failed", sendError: staleError,
        }).where(eq(paymentReminders.id, activeAttempt.id)).returning();
        await recordBusinessAudit(tx, {
          entityType: "payment_reminder", entityId: failedAttempt.id,
          recordLabel: order.orderNumber, actor: res.locals.actor, action: "updated",
          changedFields: ["status", "sendError"],
        });
        return { error: `${staleError} If it is not there, try sending again.`, status: 409 as const };
      }

      const attemptedAt = new Date();
      const [reminder] = await tx.insert(paymentReminders).values({
        salesOrderId: order.id, recipientEmail: customer.email,
        outstandingZmw: formatCents(outstanding), dueDate,
        note: parsed.data.note, status: "sending", attemptedAt,
      }).returning();
      await recordBusinessAudit(tx, {
        entityType: "payment_reminder", entityId: reminder.id,
        recordLabel: order.orderNumber, actor: res.locals.actor, action: "created",
        changedFields: ["salesOrderId", "recipientEmail", "outstandingZmw", "dueDate", "note", "status", "attemptedAt"],
      });
      return {
        reminder, content: {
          orderNumber: order.orderNumber, customerName: customer.name, customerEmail: customer.email,
          outstandingZmw: reminder.outstandingZmw, dueDate: reminder.dueDate, note: reminder.note,
        },
      };
    });
    if ("error" in claim) return res.status(claim.status ?? 400).json({ error: claim.error });

    const outcome = await sendPaymentReminderEmail(claim.content);
    const sentAt = outcome.ok ? new Date() : null;
    const [reminder] = await db.transaction(async (tx) => {
      const [updated] = await tx.update(paymentReminders).set({
        status: outcome.ok ? "sent" : "failed",
        sentAt,
        sendError: outcome.ok ? null : outcome.error,
        providerMessageId: outcome.ok ? outcome.messageId : null,
      }).where(and(
        eq(paymentReminders.id, claim.reminder.id),
        eq(paymentReminders.status, "sending"),
      )).returning();
      if (!updated) throw new Error("The payment reminder result could not be saved.");
      await recordBusinessAudit(tx, {
        entityType: "payment_reminder", entityId: updated.id,
        recordLabel: claim.content.orderNumber, actor: res.locals.actor, action: "updated",
        changedFields: ["status", "sentAt", "sendError", "providerMessageId"],
      });
      return [updated];
    });
    if (!outcome.ok) return res.status(502).json({ error: outcome.error, reminder });
    res.json({ reminder });
  });

  app.put("/api/payments/due-date", owner, async (req, res) => {
    const parsed = dueDateInputSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the due date.");
    const { direction, orderId, dueDate } = parsed.data;
    const updated = await db.transaction(async (tx) => {
      if (direction === "customer_receipt") {
        const [order] = await tx.update(salesOrders).set({ dueDate, updatedAt: new Date() })
          .where(eq(salesOrders.id, orderId)).returning({ id: salesOrders.id, orderNumber: salesOrders.orderNumber });
        if (order) await recordBusinessAudit(tx, {
          entityType: "sales_order", entityId: order.id, recordLabel: order.orderNumber,
          actor: res.locals.actor, action: "updated", changedFields: ["dueDate"],
        });
        return order;
      }
      const [order] = await tx.update(purchaseOrders).set({ dueDate, updatedAt: new Date() })
        .where(eq(purchaseOrders.id, orderId)).returning({ id: purchaseOrders.id, orderNumber: purchaseOrders.orderNumber });
      if (order) await recordBusinessAudit(tx, {
        entityType: "purchase_order", entityId: order.id, recordLabel: order.orderNumber,
        actor: res.locals.actor, action: "updated", changedFields: ["dueDate"],
      });
      return order;
    });
    if (!updated) return bad(res, "Order not found.", 404);
    res.json({ ok: true, dueDate });
  });

  app.post("/api/payments", owner, async (req, res) => {
    const parsed = paymentInputSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the payment details.");
    const input = parsed.data;
    const amount = cents(input.amountZmw);
    let result: { payment?: typeof businessPayments.$inferSelect; duplicate?: boolean; error?: string; status?: number };
    try {
      result = await db.transaction(async (tx) => {
      const [sameAttempt] = await tx.select().from(businessPayments)
        .where(eq(businessPayments.idempotencyKey, input.idempotencyKey)).limit(1);
      if (sameAttempt) {
        if (paymentMatchesRequest(sameAttempt, input)) return { payment: sameAttempt, duplicate: true };
        return { error: "This save key was already used for different payment details.", status: 409 };
      }

      let orderNumber: string;
      let invoiceId: number | null = null;
      let purchaseId: number | null = null;
      let outstanding: bigint;
      if (input.direction === "customer_receipt") {
        const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, input.orderId)).for("update").limit(1);
        if (!order) return { error: "Sales order not found.", status: 404 };
        if (order.status !== "fulfilled" && order.status !== "partially_fulfilled" && order.status !== "cancelled") {
          return { error: "Deliver goods before recording a customer payment.", status: 409 };
        }
        orderNumber = order.orderNumber;
        invoiceId = order.id;
        const deliveredLines = await tx.select({
          quantity: salesDeliveryLines.quantity, unitPriceZmw: salesOrderLines.unitPriceZmw,
        }).from(salesDeliveryLines)
          .innerJoin(salesDeliveries, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
          .innerJoin(salesOrderLines, eq(salesDeliveryLines.salesOrderLineId, salesOrderLines.id))
          .where(eq(salesDeliveries.salesOrderId, order.id));
        const lines = deliveredLines.length
          ? deliveredLines
          : order.status === "fulfilled"
            ? await tx.select({ quantity: salesOrderLines.quantity, unitPriceZmw: salesOrderLines.unitPriceZmw })
              .from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, order.id))
            : [];
        const total = lines.reduce((acc, line) => acc + cents(line.unitPriceZmw) * BigInt(line.quantity), 0n);
        const returnedLines = await tx.select({
          quantity: inventoryMovements.quantityDelta, unitPriceZmw: salesOrderLines.unitPriceZmw,
        }).from(inventoryMovements)
          .innerJoin(salesDeliveryLines, eq(inventoryMovements.salesDeliveryLineId, salesDeliveryLines.id))
          .innerJoin(salesDeliveries, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
          .innerJoin(salesOrderLines, eq(salesDeliveryLines.salesOrderLineId, salesOrderLines.id))
          .where(and(eq(salesDeliveries.salesOrderId, order.id), eq(inventoryMovements.kind, "stock_return")));
        const returned = returnedLines.reduce((acc, line) =>
          acc + cents(line.unitPriceZmw) * BigInt(line.quantity), 0n);
        const existing = await tx.select({ amount: sum(businessPayments.amountZmw) }).from(businessPayments)
          .where(and(eq(businessPayments.direction, "customer_receipt"), eq(businessPayments.salesOrderId, order.id)));
        outstanding = total - returned - cents(String(existing[0]?.amount ?? "0.00"));
      } else {
        const [order] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.orderId)).for("update").limit(1);
        if (!order) return { error: "Purchase order not found.", status: 404 };
        if (order.status === "cancelled") return { error: "Cancelled purchase orders cannot receive supplier payments.", status: 409 };
        orderNumber = order.orderNumber;
        purchaseId = order.id;
        const total = await payableForPurchaseOrder(tx, order.id, order.orderNumber);
        const existing = await tx.select({ amount: sum(businessPayments.amountZmw) }).from(businessPayments)
          .where(and(eq(businessPayments.direction, "supplier_payment"), eq(businessPayments.purchaseOrderId, order.id)));
        outstanding = total - cents(String(existing[0]?.amount ?? "0.00"));
      }
      if (input.reference) {
        const matchingReference = await tx.select({ id: businessPayments.id }).from(businessPayments)
          .where(and(
            eq(businessPayments.direction, input.direction),
            input.direction === "customer_receipt"
              ? eq(businessPayments.salesOrderId, input.orderId)
              : eq(businessPayments.purchaseOrderId, input.orderId),
            eq(businessPayments.amountZmw, formatCents(amount)),
            eq(businessPayments.paymentDate, input.paymentDate),
            eq(businessPayments.method, input.method),
            sql`lower(btrim(${businessPayments.reference})) = ${input.reference.toLowerCase()}`,
          )).limit(1);
        if (matchingReference.length) {
          return { error: "A payment with this reference, date, and amount is already recorded.", status: 409 };
        }
      }
      if (outstanding <= 0n) return { error: "This order has no outstanding balance.", status: 409 };
      if (amount > outstanding) return { error: `Payment is more than the outstanding balance of ZMW ${formatCents(outstanding)}.`, status: 400 };

      const [payment] = await tx.insert(businessPayments).values({
        paymentNumber: `PAY-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`,
        idempotencyKey: input.idempotencyKey,
        direction: input.direction, salesOrderId: invoiceId, purchaseOrderId: purchaseId,
        amountZmw: formatCents(amount), paymentDate: input.paymentDate, method: input.method,
        reference: input.reference, notes: input.notes,
      }).returning();
      await recordBusinessAudit(tx, {
        entityType: "payment", entityId: payment.id, recordLabel: payment.paymentNumber,
        actor: res.locals.actor, action: "created", changedFields: ["direction", "salesOrderId", "purchaseOrderId", "amountZmw", "paymentDate", "method", "reference", "notes"],
      });
      const cashAccountKey = cashAccountKeyForMethod(input.method);
      await postJournal(tx, {
        sourceKey: `payment-${payment.id}`, sourceType: "payment", sourceId: payment.id,
        memo: `${input.direction === "customer_receipt" ? "Customer receipt" : "Supplier payment"} ${payment.paymentNumber} for ${orderNumber}`,
        entryDate: input.paymentDate,
        lines: input.direction === "customer_receipt"
          ? [
              { accountKey: cashAccountKey, debitZmw: formatCents(amount), description: "Payment received" },
              { accountKey: "accounts_receivable", creditZmw: formatCents(amount), description: "Customer balance reduced" },
            ]
          : [
              { accountKey: "accounts_payable", debitZmw: formatCents(amount), description: "Supplier balance reduced" },
              { accountKey: cashAccountKey, creditZmw: formatCents(amount), description: "Payment made" },
            ],
      });
      return { payment };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const [sameAttempt] = await db.select().from(businessPayments)
        .where(eq(businessPayments.idempotencyKey, input.idempotencyKey)).limit(1);
      if (sameAttempt && paymentMatchesRequest(sameAttempt, input)) {
        result = { payment: sameAttempt, duplicate: true };
      } else {
        return bad(res, "This payment was already recorded. Check the payment history and outstanding balance.", 409);
      }
    }
    if ("error" in result) return bad(res, result.error ?? "Could not save the payment.", result.status ?? 400);
    res.status(result.duplicate ? 200 : 201).json({ payment: result.payment });
  });
}
