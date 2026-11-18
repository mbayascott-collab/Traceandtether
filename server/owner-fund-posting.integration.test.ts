import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import test from "node:test";
import {
  businessAuditLogs, journalEntries, journalLines, ownerFundTransactions,
} from "../shared/schema";

test("owner-fund routes save one linked, balanced journal entry and roll back failed postings", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db, pool }, { registerAccountingRoutes }] = await Promise.all([
    import("./db"),
    import("./accounting-routes"),
  ]);

  const suffix = randomUUID();
  const actorEmail = `owner-fund-posting-${suffix}@example.test`;
  const failureMarker = `owner-fund-posting-failure-${suffix}`;
  const functionName = `owner_fund_posting_failure_${suffix.replace(/-/g, "")}`;
  const triggerName = `${functionName}_trigger`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerAccountingRoutes(app, owner);
  app.use(((error: unknown, _req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  }) as express.ErrorRequestHandler);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const savedTransactionIds: number[] = [];
  const savedJournalIds: number[] = [];
  let triggerInstalled = false;

  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json() as any;
    return { response, payload };
  };

  try {
    await pool.query(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF position('${failureMarker}' in coalesce(NEW.description, '')) > 0 THEN
          RAISE EXCEPTION 'Simulated owner-fund journal posting failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON journal_lines
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    triggerInstalled = true;

    const cases = [
      { kind: "owner_contribution", method: "cash", receivedAt: "2001-02-03" },
      { kind: "business_loan", method: "bank_transfer", receivedAt: "2001-05-06" },
      { kind: "owner_withdrawal", method: "mobile_money", receivedAt: "2001-08-09" },
    ] as const;

    for (const { kind, method, receivedAt } of cases) {
      const reference = `${kind}-${suffix}`;
      const { response, payload } = await request("/api/accounting/funds", {
        kind,
        amountZmw: "25.50",
        receivedAt,
        method,
        reference,
        notes: `Test posting ${suffix}`,
      });
      assert.equal(response.status, 201, JSON.stringify(payload));

      const transactionId = payload.transaction.id as number;
      const journalId = payload.journal.id as number;
      savedTransactionIds.push(transactionId);
      savedJournalIds.push(journalId);
      assert.equal(payload.transaction.kind, kind);
      assert.equal(payload.transaction.transactionDate, receivedAt);

      const linkedEntries = await db.select().from(journalEntries).where(and(
        eq(journalEntries.sourceType, kind),
        eq(journalEntries.sourceId, transactionId),
      ));
      assert.equal(linkedEntries.length, 1, `${kind} source should have exactly one journal entry`);
      assert.equal(linkedEntries[0].id, journalId);
      assert.equal(linkedEntries[0].sourceKey, `owner-fund-${transactionId}`);
      assert.equal(linkedEntries[0].entryDate, receivedAt);

      const lines = await db.select().from(journalLines).where(eq(journalLines.journalEntryId, journalId));
      assert.equal(lines.length, 2);
      const debitTotal = lines.reduce((total, line) => total + Math.round(Number(line.debitZmw) * 100), 0);
      const creditTotal = lines.reduce((total, line) => total + Math.round(Number(line.creditZmw) * 100), 0);
      assert.equal(debitTotal, 2_550);
      assert.equal(creditTotal, debitTotal);

      const report = await request(`/api/accounting?from=${receivedAt}&to=${receivedAt}`);
      assert.equal(report.response.status, 200, JSON.stringify(report.payload));
      const reportEntries = report.payload.entries.filter((entry: any) => entry.id === journalId);
      assert.equal(reportEntries.length, 1, `${kind} journal should appear once in its reporting period`);
      assert.equal(reportEntries[0].sourceType, kind);
      assert.equal(reportEntries[0].sourceId, transactionId);
      assert.deepEqual(
        report.payload.ownerTransactions.filter((transaction: any) => transaction.id === transactionId)
          .map((transaction: any) => transaction.kind),
        [kind],
      );
    }

    const failedReference = `failed-${suffix}`;
    const failedResponse = await fetch(`${baseUrl}/api/accounting/funds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "owner_contribution",
        amountZmw: "40.00",
        receivedAt: "2001-11-12",
        method: "cash",
        reference: failedReference,
        notes: failureMarker,
      }),
    });
    assert.equal(failedResponse.status, 500);

    const failedSources = await db.select().from(ownerFundTransactions)
      .where(eq(ownerFundTransactions.reference, failedReference));
    assert.equal(failedSources.length, 0, "failed journal posting must roll back the source record");
    const failedEntries = await db.select().from(journalEntries)
      .where(eq(journalEntries.memo, `Owner contribution · ${failedReference}`));
    assert.equal(failedEntries.length, 0, "failed journal posting must roll back the journal entry");
  } finally {
    if (triggerInstalled) {
      await pool.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON journal_lines`);
      await pool.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    } else {
      await pool.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }

    if (savedJournalIds.length) {
      await db.delete(journalLines).where(inArray(journalLines.journalEntryId, savedJournalIds));
      await db.delete(businessAuditLogs).where(and(
        eq(businessAuditLogs.entityType, "journal_entry"),
        inArray(businessAuditLogs.entityId, savedJournalIds),
      ));
      await db.delete(journalEntries).where(inArray(journalEntries.id, savedJournalIds));
    }
    if (savedTransactionIds.length) {
      await db.delete(businessAuditLogs).where(and(
        eq(businessAuditLogs.entityType, "owner_fund_transaction"),
        inArray(businessAuditLogs.entityId, savedTransactionIds),
      ));
      await db.delete(ownerFundTransactions).where(inArray(ownerFundTransactions.id, savedTransactionIds));
    }

    server.close();
    await once(server, "close");
    await pool.end();
  }
});
