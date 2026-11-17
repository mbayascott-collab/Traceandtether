import { and, desc, eq, inArray, sum } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import {
  accountingAccounts, businessPayments, customers, journalEntries, journalLines, purchaseOrders,
  salesDeliveryLines, salesDeliveries, salesOrderLines, salesOrders, suppliers,
} from "../shared/schema";
import { db } from "./db";
import { cashAccountKeyForMethod, cents, ensureAccountingAccounts, formatCents, postJournal } from "./accounting-posting";
import { paymentInputSchema } from "./payment-validation";

const bad = (res: import("express").Response, message: string, status = 400) => res.status(status).json({ error: message });

async function payableForPurchaseOrder(tx: any, orderNumber: string) {
  const accountsByKey = await ensureAccountingAccounts(tx);
  const payableAccount = accountsByKey.get("accounts_payable");
  if (!payableAccount) return 0n;
  const [row] = await tx.select({ total: sum(journalLines.creditZmw) })
    .from(journalEntries)
    .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
    .where(and(
      eq(journalEntries.memo, `Stock receipt for ${orderNumber}`),
      eq(journalLines.accountId, payableAccount.id),
    ));
  return cents(String(row?.total ?? "0.00"));
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
        .where(inArray(purchaseOrders.status, ["partially_received", "received"])),
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

    let payableRows: Array<{ memo: string; total: string | null }> = [];
    const payableAccount = accountMap.get("accounts_payable");
    if (payableAccount && openPurchaseOrders.length) {
      payableRows = await db.select({ memo: journalEntries.memo, total: sum(journalLines.creditZmw) })
        .from(journalEntries)
        .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
        .where(and(
          eq(journalLines.accountId, payableAccount.id),
          inArray(journalEntries.memo, openPurchaseOrders.map(({ order }) => `Stock receipt for ${order.orderNumber}`)),
        )).groupBy(journalEntries.memo);
    }
    const payableByMemo = new Map(payableRows.map((row) => [row.memo, cents(String(row.total ?? "0.00"))]));
    const bills = openPurchaseOrders.map(({ order, supplierName }) => {
      const total = payableByMemo.get(`Stock receipt for ${order.orderNumber}`) ?? 0n;
      const paid = paidPurchases.get(order.id) ?? 0n;
      return { orderId: order.id, orderNumber: order.orderNumber, partyName: supplierName, totalZmw: formatCents(total), paidZmw: formatCents(paid), outstandingZmw: formatCents(total - paid) };
    }).filter((item) => cents(item.outstandingZmw) > 0n);

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
    const result = await db.transaction(async (tx) => {
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
        if (order.status !== "partially_received" && order.status !== "received") return { error: "Supplier payments can be recorded after stock is received.", status: 409 };
        orderNumber = order.orderNumber;
        purchaseId = order.id;
        const total = await payableForPurchaseOrder(tx, order.orderNumber);
        const existing = await tx.select({ amount: sum(businessPayments.amountZmw) }).from(businessPayments)
          .where(and(eq(businessPayments.direction, "supplier_payment"), eq(businessPayments.purchaseOrderId, order.id)));
        outstanding = total - cents(String(existing[0]?.amount ?? "0.00"));
      }
      if (outstanding <= 0n) return { error: "This order has no outstanding balance.", status: 409 };
      if (amount > outstanding) return { error: `Payment is more than the outstanding balance of ZMW ${formatCents(outstanding)}.`, status: 400 };

      const [payment] = await tx.insert(businessPayments).values({
        paymentNumber: `PAY-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`,
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
    if ("error" in result) return bad(res, result.error ?? "Could not save the payment.", result.status ?? 400);
    res.status(201).json({ payment: result.payment });
  });
}
