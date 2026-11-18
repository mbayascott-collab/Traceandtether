import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import test from "node:test";
import {
  accountingAccounts, businessAuditLogs, journalEntries, journalLines,
} from "../shared/schema";
import { buildOpeningBalanceLines, journalLinesAreBalanced } from "./accounting-posting";

test("opening-balance reversals and replacements reject retries and concurrent duplicates", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [
    { db, pool },
    { registerAccountingRoutes },
    { ensureAccountingAccounts },
  ] = await Promise.all([
    import("./db"),
    import("./accounting-routes"),
    import("./accounting-posting"),
  ]);

  const suffix = randomUUID();
  const actorEmail = `opening-balance-corrections-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const actorMiddleware: RequestHandler = (req, res, next) => {
    const role = req.get("x-test-role") === "manager" ? "manager" : "owner";
    res.locals.actor = { clerkUserId: `opening-balance-test-${suffix}`, email: actorEmail, role };
    next();
  };
  registerAccountingRoutes(app, actorMiddleware);
  app.use(((error: unknown, _req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  }) as express.ErrorRequestHandler);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const fixtureEntryIds: number[] = [];

  const post = async (path: string, body: unknown, role: "owner" | "manager" = "owner") => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-role": role,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() as any };
  };

  try {
    const originalLines = buildOpeningBalanceLines({
      cashOnHandZmw: "125.00",
      bankZmw: "0.00",
      mobileMoneyZmw: "0.00",
      otherFundsZmw: "0.00",
      receivablesZmw: "0.00",
      payablesZmw: "0.00",
      loansPayableZmw: "0.00",
      ownerEquityZmw: "0.00",
    });
    const original = await db.transaction(async (tx) => {
      const accounts = await ensureAccountingAccounts(tx);
      const [entry] = await tx.insert(journalEntries).values({
        entryNumber: `JE-TEST-${suffix.slice(0, 8)}`,
        sourceKey: `opening-balance-test-${suffix}`,
        sourceType: "opening_balances",
        sourceId: null,
        memo: "Opening-balance correction integration fixture",
        entryDate: "2026-11-18",
      }).returning();
      await tx.insert(journalLines).values(originalLines.map((line) => ({
        journalEntryId: entry.id,
        accountId: accounts.get(line.accountKey)!.id,
        debitZmw: line.debitZmw ?? "0.00",
        creditZmw: line.creditZmw ?? "0.00",
        description: line.description ?? null,
      })));
      return entry;
    });
    fixtureEntryIds.push(original.id);

    const reversalBody = { effectiveAt: "2026-11-18", reason: `Correction test ${suffix}` };
    assert.equal(
      (await post(`/api/accounting/opening-balances/${original.id}/reverse`, reversalBody, "manager")).status,
      403,
      "a manager must not reverse opening balances",
    );

    const reversalAttempts = await Promise.all([
      post(`/api/accounting/opening-balances/${original.id}/reverse`, reversalBody),
      post(`/api/accounting/opening-balances/${original.id}/reverse`, reversalBody),
    ]);
    assert.deepEqual(reversalAttempts.map(({ status }) => status).sort(), [201, 409]);
    assert.equal(
      (await post(`/api/accounting/opening-balances/${original.id}/reverse`, reversalBody)).status,
      409,
      "a repeated reversal request must be rejected",
    );

    const reversalRows = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "opening_balance_reversal"),
      eq(journalEntries.sourceId, original.id),
    ));
    assert.equal(reversalRows.length, 1, "only one reversal may be linked to the original entry");
    const reversal = reversalRows[0]!;
    fixtureEntryIds.push(reversal.id);
    assert.equal(reversal.sourceKey, `opening-balance-reversal-${original.id}`);

    const replacementBody = {
      reversalEntryId: reversal.id,
      effectiveAt: "2026-11-18",
      cashOnHandZmw: "150.00",
      bankZmw: "0.00",
      mobileMoneyZmw: "0.00",
      otherFundsZmw: "0.00",
      receivablesZmw: "0.00",
      payablesZmw: "0.00",
      loansPayableZmw: "0.00",
      ownerEquityZmw: "0.00",
      memo: `Corrected opening balances ${suffix}`,
    };
    assert.equal(
      (await post("/api/accounting/opening-balances", replacementBody, "manager")).status,
      403,
      "a manager must not replace opening balances",
    );

    const replacementAttempts = await Promise.all([
      post("/api/accounting/opening-balances", replacementBody),
      post("/api/accounting/opening-balances", replacementBody),
    ]);
    assert.deepEqual(replacementAttempts.map(({ status }) => status).sort(), [201, 409]);
    assert.equal(
      (await post("/api/accounting/opening-balances", replacementBody)).status,
      409,
      "a repeated replacement request must be rejected",
    );

    const replacementRows = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "opening_balances"),
      eq(journalEntries.sourceId, reversal.id),
    ));
    assert.equal(replacementRows.length, 1, "only one replacement may be linked to the reversal");
    const replacement = replacementRows[0]!;
    fixtureEntryIds.push(replacement.id);
    assert.equal(replacement.sourceKey, `opening-balance-replacement-${reversal.id}`);
    assert.equal(reversal.sourceId, original.id);
    assert.equal(original.sourceType, "opening_balances");

    for (const entry of [original, reversal, replacement]) {
      const lines = await db.select({
        accountKey: accountingAccounts.systemKey,
        debitZmw: journalLines.debitZmw,
        creditZmw: journalLines.creditZmw,
      }).from(journalLines)
        .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
        .where(eq(journalLines.journalEntryId, entry.id));
      assert.ok(lines.length > 0, `journal entry ${entry.id} must have linked lines`);
      assert.equal(journalLinesAreBalanced(lines.map((line) => ({
        accountKey: line.accountKey ?? "",
        debitZmw: line.debitZmw,
        creditZmw: line.creditZmw,
      }))), true, `journal entry ${entry.id} must remain balanced`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (fixtureEntryIds.length) {
      await db.delete(businessAuditLogs).where(and(
        eq(businessAuditLogs.entityType, "journal_entry"),
        inArray(businessAuditLogs.entityId, fixtureEntryIds),
      ));
      await db.delete(journalLines).where(inArray(journalLines.journalEntryId, fixtureEntryIds));
      await db.delete(journalEntries).where(inArray(journalEntries.id, fixtureEntryIds));
    }
    await pool.end();
  }
});
