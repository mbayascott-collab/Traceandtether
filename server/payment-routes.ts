import { and, desc, eq, inArray, ne, sql, sum } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  accountingAccounts, businessPayments, customers, importExpenses, journalEntries, journalLines, purchaseOrders,
  salesDeliveryLines, salesDeliveries, salesOrderLines, salesOrders, suppliers,
} from "../shared/schema";
import { db } from "./db";
import { cashAccountKeyForMethod, cents, ensureAccountingAccounts, formatCents, postJournal } from "./accounting-posting";
import { paymentInputSchema } from "./payment-validation";

const bad = (res: import("express").Response, message: string, status = 400) => res.status(status).json({ error: message });

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

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "23505";
}

export function registerPaymentRoutes(app: Express, owner: RequestHandler) {
  app.get("/api/payments", owner, async (_req, res) => {
    const accountMap = await ensureAccountingAccounts(db);
    const [paymentRows, eligibleOrders, orderLines, deliveryRows, openPurchaseOrders] = await Promise.all([
      db.select({
        payment: businessPayments, salesOrderNumber: salesOrders.orderNumber, customerName: customers.name,
        purchaseOrderNumber: purchaseOrders.orderNumber, supplierName: suppliers.name,
      }).from(businessPayments)
        .leftJoin(salesOrders, eq(businessPayments.salesOrderId, salesOrders.id))
        .leftJoin(customers, eq(salesOrders.customerId, customers.id))
        .leftJoin(purchaseOrders, eq(businessPayments.purchaseOrderId, purchaseOrders.id))
        .leftJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
        .orderBy(desc(businessPayments.paymentDate), desc(businessPayments.createdAt)),
      db.select({ order: salesOrders, customerName: customers.name }).from(salesOrders)
        .innerJoin(customers, eq(salesOrders.customerId, customers.id))
        .where(inArray(salesOrders.status, ["partially_fulfilled", "fulfilled", "cancelled"])),
      db.select().from(salesOrderLines),
      db.select({
        orderId: salesDeliveries.salesOrderId, quantity: salesDeliveryLines.quantity, unitPriceZmw: salesOrderLines.unitPriceZmw,
      }).from(salesDeliveryLines)
        .innerJoin(salesDeliveries, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
        .innerJoin(salesOrderLines, eq(salesDeliveryLines.salesOrderLineId, salesOrderLines.id)),
      db.select({ order: purchaseOrders, supplierName: suppliers.name }).from(purchaseOrders)
        .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
        .where(ne(purchaseOrders.status, "cancelled")),
    ]);

    const payments = await db.select().from(businessPayments);
    const paidSales = new Map<number, bigint>();
    const paidPurchases = new Map<number, bigint>();
    for (const payment of payments) {
      const key = payment.direction === "customer_receipt" ? payment.salesOrderId : payment.purchaseOrderId;
      const target = payment.direction === "customer_receipt" ? paidSales : paidPurchases;
      if (key !== null) target.set(key, (target.get(key) ?? 0n) + cents(payment.amountZmw));
    }

    const deliveredTotals = new Map<number, bigint>();
    for (const row of deliveryRows) {
      deliveredTotals.set(row.orderId, (deliveredTotals.get(row.orderId) ?? 0n) + cents(row.unitPriceZmw) * BigInt(row.quantity));
    }
    const ordersWithDelivery = new Set(deliveryRows.map((row) => row.orderId));
    const invoices = eligibleOrders.map(({ order, customerName }) => {
      const total = ordersWithDelivery.has(order.id)
        ? deliveredTotals.get(order.id) ?? 0n
        : order.status === "fulfilled"
          ? orderLines.filter((line) => line.salesOrderId === order.id)
            .reduce((acc, line) => acc + cents(line.unitPriceZmw) * BigInt(line.quantity), 0n)
          : 0n;
      const outstanding = total - (paidSales.get(order.id) ?? 0n);
      return { orderId: order.id, orderNumber: order.orderNumber, partyName: customerName, totalZmw: formatCents(total), paidZmw: formatCents(paidSales.get(order.id) ?? 0n), outstandingZmw: formatCents(outstanding) };
    }).filter((item) => cents(item.outstandingZmw) > 0n);

    const bills: Array<{ orderId: number; orderNumber: string; partyName: string; totalZmw: string; paidZmw: string; outstandingZmw: string }> = [];
    for (const { order, supplierName } of openPurchaseOrders) {
      const total = await payableForPurchaseOrder(db, order.id, order.orderNumber, accountMap);
      const paid = paidPurchases.get(order.id) ?? 0n;
      if (total > paid) bills.push({
        orderId: order.id, orderNumber: order.orderNumber, partyName: supplierName,
        totalZmw: formatCents(total), paidZmw: formatCents(paid), outstandingZmw: formatCents(total - paid),
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
        const existing = await tx.select({ amount: sum(businessPayments.amountZmw) }).from(businessPayments)
          .where(and(eq(businessPayments.direction, "customer_receipt"), eq(businessPayments.salesOrderId, order.id)));
        outstanding = total - cents(String(existing[0]?.amount ?? "0.00"));
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
