import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test from "node:test";
import { asc, inArray } from "drizzle-orm";
import {
  businessPayments, customers, journalEntries, journalLines,
  paymentStatementLines, salesOrders,
} from "../shared/schema";
import { ensureAccountingAccounts, postJournal } from "./accounting-posting";

test("adding, matching, and unmatching statement lines never changes journals", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [
    { db, pool },
    { registerPaymentRoutes },
  ] = await Promise.all([
    import("./db"),
    import("./payment-routes"),
  ]);

  const suffix = randomUUID();
  const label = suffix.slice(0, 12);
  const email = `payment-reconciliation-${suffix}@example.test`;
  const auditTable = await pool.query(
    "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
  );
  if (!auditTable.rows[0]?.exists) {
    t.skip("requires the business audit database migration");
    await pool.end();
    return;
  }

  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email, role: "owner" };
    next();
  };
  registerPaymentRoutes(app, owner);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let customerId: number | undefined;
  let orderId: number | undefined;
  let paymentId: number | undefined;
  let journalEntryId: number | undefined;
  let statementLineIds: number[] = [];
  const request = async (path: string, method: string, body: unknown, expectedStatus: number) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as any;
    assert.equal(response.status, expectedStatus, JSON.stringify(payload));
    return payload;
  };
  const journalSnapshot = async () => {
    const [entries, lines] = await Promise.all([
      db.select().from(journalEntries).orderBy(asc(journalEntries.id)),
      db.select().from(journalLines).orderBy(asc(journalLines.id)),
    ]);
    return { entries, lines };
  };

  try {
    const [customer] = await db.insert(customers).values({
      name: `Reconciliation test customer ${suffix}`,
    }).returning();
    customerId = customer.id;
    const [order] = await db.insert(salesOrders).values({
      orderNumber: `RECON-${label}`,
      customerId,
      status: "fulfilled",
      orderDate: "2026-11-10",
    }).returning();
    orderId = order.id;
    const [payment] = await db.insert(businessPayments).values({
      paymentNumber: `PAY-RECON-${label}`,
      direction: "customer_receipt",
      salesOrderId: orderId,
      amountZmw: "125.00",
      paymentDate: "2026-11-10",
      method: "bank_transfer",
      reference: `REF-${suffix}`,
    }).returning();
    paymentId = payment.id;

    const accountMap = await ensureAccountingAccounts(db);
    const bankAccount = accountMap.get("bank_account");
    const receivablesAccount = accountMap.get("accounts_receivable");
    assert.ok(bankAccount && receivablesAccount);
    const entry = await db.transaction((tx) => postJournal(tx, {
      sourceKey: `payment-${paymentId}`,
      sourceType: "payment",
      sourceId: paymentId!,
      memo: `Customer receipt ${payment.paymentNumber}`,
      entryDate: payment.paymentDate,
      lines: [
        { accountKey: "bank_account", debitZmw: "125.00", description: "Payment received" },
        { accountKey: "accounts_receivable", creditZmw: "125.00", description: "Customer balance reduced" },
      ],
    }));
    journalEntryId = entry.id;
    assert.ok(entry);

    const before = await journalSnapshot();
    const lines = [
      { transactionDate: "2026-11-10", flow: "in", amountZmw: "125.00", reference: `REF-${suffix}` },
      { transactionDate: "2026-11-10", flow: "in", amountZmw: "124.99", reference: `REF-${suffix}` },
      { transactionDate: "2026-11-11", flow: "in", amountZmw: "125.00", reference: `REF-${suffix}` },
      { transactionDate: "2026-11-10", flow: "in", amountZmw: "125.00", reference: `OTHER-${suffix}` },
      { transactionDate: "2026-11-10", flow: "out", amountZmw: "125.00", reference: `REF-${suffix}` },
    ] as const;
    await request("/api/payments/reconciliation/lines", "POST", {
      accountId: bankAccount.id,
      from: "2026-11-10",
      to: "2026-11-11",
      lines: lines.map((line) => ({ ...line, description: "Reconciliation regression test" })),
    }, 201);
    assert.deepEqual(await journalSnapshot(), before, "adding statement lines must not post journals");

    const statementRows = await db.select().from(paymentStatementLines)
      .where(inArray(paymentStatementLines.reference, lines.map((line) => line.reference)))
      .orderBy(asc(paymentStatementLines.id));
    statementLineIds = statementRows.map((line) => line.id);
    assert.equal(statementRows.length, 5);

    for (const statementLine of statementRows) {
      await request("/api/payments/reconciliation/match", "PUT", {
        lineId: statementLine.id, paymentId,
      }, 200);
      assert.deepEqual(await journalSnapshot(), before, "matching a comparison, even with mismatches, must not change journals");

      await request("/api/payments/reconciliation/match", "PUT", {
        lineId: statementLine.id, paymentId: null,
      }, 200);
      assert.deepEqual(await journalSnapshot(), before, "unmatching must not change journals");
    }

    const firstLineId = statementRows[0]!.id;
    const secondLineId = statementRows[1]!.id;
    await request("/api/payments/reconciliation/match", "PUT", {
      lineId: firstLineId, paymentId,
    }, 200);
    assert.deepEqual(await journalSnapshot(), before);
    await request("/api/payments/reconciliation/match", "PUT", {
      lineId: secondLineId, paymentId,
    }, 409);
    assert.deepEqual(await journalSnapshot(), before, "rejecting a duplicate match must not change journals");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [email]);
      if (statementLineIds.length) {
        await client.query("DELETE FROM payment_statement_lines WHERE id = ANY($1::int[])", [statementLineIds]);
      }
      if (journalEntryId) {
        await client.query("DELETE FROM journal_lines WHERE journal_entry_id = $1", [journalEntryId]);
        await client.query("DELETE FROM journal_entries WHERE id = $1", [journalEntryId]);
      }
      if (paymentId) await client.query("DELETE FROM business_payments WHERE id = $1", [paymentId]);
      if (orderId) await client.query("DELETE FROM sales_orders WHERE id = $1", [orderId]);
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }
});
