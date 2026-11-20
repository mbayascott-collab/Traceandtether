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
  const get = async (path: string) => {
    const response = await fetch(`${baseUrl}${path}`);
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
        entryDate: "2026-11-17",
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

    const reversalBody = { effectiveAt: "2026-11-17", reason: `Correction test ${suffix}` };
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
      effectiveAt: "2026-11-17",
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

    const secondReversalBody = { ...reversalBody, effectiveAt: "2026-11-19" };
    assert.equal(
      (await post(`/api/accounting/opening-balances/${replacement.id}/reverse`, secondReversalBody)).status,
      201,
      "a replacement may be reversed for a later correction",
    );
    const secondReversalRows = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "opening_balance_reversal"),
      eq(journalEntries.sourceId, replacement.id),
    ));
    assert.equal(secondReversalRows.length, 1, "the replacement must have exactly one reversal");
    const secondReversal = secondReversalRows[0]!;
    fixtureEntryIds.push(secondReversal.id);

    const secondReplacementBody = {
      ...replacementBody,
      reversalEntryId: secondReversal.id,
      effectiveAt: "2026-11-19",
      cashOnHandZmw: "175.00",
      memo: `Second corrected opening balances ${suffix}`,
    };
    assert.equal((await post("/api/accounting/opening-balances", secondReplacementBody)).status, 201);
    const secondReplacementRows = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "opening_balances"),
      eq(journalEntries.sourceId, secondReversal.id),
    ));
    assert.equal(secondReplacementRows.length, 1, "the second replacement must link to its reversal");
    const secondReplacement = secondReplacementRows[0]!;
    fixtureEntryIds.push(secondReplacement.id);

    assert.equal(secondReversal.sourceId, replacement.id);
    assert.equal(secondReplacement.sourceKey, `opening-balance-replacement-${secondReversal.id}`);

    const historyResponse = await get("/api/accounting?from=2026-11-19&to=2026-11-19");
    assert.equal(historyResponse.status, 200, JSON.stringify(historyResponse.payload));
    const openingHistory = historyResponse.payload.openingBalances.history;
    assert.equal(openingHistory.length, 5, "history must return the original and both correction cycles exactly once");
    assert.deepEqual(
      openingHistory.map((entry: { id: number }) => entry.id).sort((a: number, b: number) => a - b),
      [original.id, reversal.id, replacement.id, secondReversal.id, secondReplacement.id].sort((a, b) => a - b),
    );
    assert.equal(new Set(openingHistory.map((entry: { id: number }) => entry.id)).size, 5);
    assert.deepEqual(
      openingHistory.filter((entry: { entryDate: string }) => entry.entryDate === "2026-11-17")
        .map((entry: { id: number }) => entry.id).sort((a: number, b: number) => a - b),
      [original.id, reversal.id, replacement.id].sort((a, b) => a - b),
      "entries outside the narrow report period must remain available to explain the linked history",
    );
    assert.deepEqual(
      openingHistory.filter((entry: { entryDate: string }) => entry.entryDate === "2026-11-19")
        .map((entry: { id: number }) => entry.id).sort((a: number, b: number) => a - b),
      [secondReversal.id, secondReplacement.id].sort((a, b) => a - b),
    );

    type OpeningHistoryEntry = {
      id: number;
      entryDate: string;
      entryNumber: string;
      memo: string;
      kind: string;
      relatedEntryId: number | null;
      reversalEntryId: number | null;
      reversed: boolean;
      active: boolean;
    };
    const historyById = new Map<number, OpeningHistoryEntry>(
      openingHistory.map((entry: OpeningHistoryEntry) => [entry.id, entry]),
    );
    assert.deepEqual(historyById.get(original.id), {
      id: original.id,
      entryDate: original.entryDate,
      entryNumber: original.entryNumber,
      memo: original.memo,
      kind: "opening_balance",
      relatedEntryId: null,
      reversalEntryId: reversal.id,
      reversed: true,
      active: false,
    });
    assert.equal(historyById.get(reversal.id)?.kind, "reversal");
    assert.equal(historyById.get(reversal.id)?.relatedEntryId, original.id);
    assert.equal(historyById.get(reversal.id)?.active, false);
    assert.equal(historyById.get(replacement.id)?.kind, "replacement");
    assert.equal(historyById.get(replacement.id)?.relatedEntryId, reversal.id);
    assert.equal(historyById.get(replacement.id)?.reversalEntryId, secondReversal.id);
    assert.equal(historyById.get(replacement.id)?.reversed, true);
    assert.equal(historyById.get(replacement.id)?.active, false);
    assert.equal(historyById.get(secondReversal.id)?.kind, "reversal");
    assert.equal(historyById.get(secondReversal.id)?.relatedEntryId, replacement.id);
    assert.equal(historyById.get(secondReversal.id)?.active, false);
    assert.equal(historyById.get(secondReplacement.id)?.kind, "replacement");
    assert.equal(historyById.get(secondReplacement.id)?.relatedEntryId, secondReversal.id);
    assert.equal(historyById.get(secondReplacement.id)?.reversalEntryId, null);
    assert.equal(historyById.get(secondReplacement.id)?.reversed, false);
    assert.equal(historyById.get(secondReplacement.id)?.active, true);
    assert.equal(historyResponse.payload.openingBalances.activeEntryId, secondReplacement.id);

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
    for (const entry of [secondReversal, secondReplacement]) {
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
