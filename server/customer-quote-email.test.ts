import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test from "node:test";
import { eq } from "drizzle-orm";
import { customers, customerQuoteLines, customerQuotes, products } from "../shared/schema";
import { buildCustomerQuoteEmail, sendCustomerQuoteEmail, type CustomerQuoteEmailContent } from "./customer-quote-email";

const quote: CustomerQuoteEmailContent = {
  quoteNumber: "CQ-2026-ABC123",
  customerName: "Customer",
  customerEmail: "customer@example.test",
  validUntil: "2026-12-31",
  deliveryAddress: "Lusaka",
  notes: "Please call before delivery.",
  totalZmw: "1250.50",
  lines: [{
    productName: "Handmade bag",
    sku: "BAG-1",
    quantity: 2,
    unitPriceZmw: "625.25",
    lineTotalZmw: "1250.50",
  }],
};

function decodeRaw(value: string) {
  const raw = Buffer.from(value, "base64url").toString("utf8");
  const separator = raw.indexOf("\r\n\r\n");
  assert.notEqual(separator, -1);
  const encodedBody = raw.slice(separator + 4).replace(/\r\n/g, "");
  return { raw: raw.slice(0, separator), body: Buffer.from(encodedBody, "base64").toString("utf8") };
}

test("builds a Gmail-ready customer quote with its saved recipient and full price details", () => {
  const { raw, body } = decodeRaw(buildCustomerQuoteEmail(quote));
  assert.match(raw, /^To: customer@example\.test\r\n/);
  assert.match(raw, /Subject: Customer quote CQ-2026-ABC123/);
  assert.match(body, /Dear Customer,/);
  assert.match(body, /Handmade bag \(BAG-1\): 2 × ZMW 625\.25 = ZMW 1,250\.50/);
  assert.match(body, /Total: ZMW 1,250\.50/);
  assert.match(body, /Valid until: 2026-12-31/);
  assert.match(body, /Delivery address: Lusaka/);
  assert.match(body, /Please call before delivery\./);
});

test("sends the encoded message using Gmail and reports provider errors", async () => {
  let requestBody: unknown;
  const accepted = await sendCustomerQuoteEmail(quote, {
    async proxy(connector, path, options) {
      assert.equal(connector, "google-mail");
      assert.equal(path, "/gmail/v1/users/me/messages/send");
      requestBody = options?.body;
      return new Response(JSON.stringify({ id: "gmail-message-1" }), { status: 200 });
    },
  });
  assert.deepEqual(accepted, { ok: true, messageId: "gmail-message-1" });
  assert.equal(typeof requestBody === "object" && requestBody !== null && "raw" in requestBody, true);

  const rejected = await sendCustomerQuoteEmail(quote, {
    async proxy() {
      return new Response(JSON.stringify({ error: { message: "Insufficient Permission" } }), { status: 403 });
    },
  });
  assert.deepEqual(rejected, {
    ok: false,
    error: "Gmail could not send the quote (HTTP 403): Insufficient Permission",
  });
});

test("customer quote sends prevent concurrent duplicates and require confirmation for stale attempts", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerSalesRoutes }] = await Promise.all([
    import("./db"),
    import("./sales-routes"),
  ]);
  const auditTable = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
  );
  if (!auditTable.rows[0]?.exists) {
    await pool.end();
    t.skip("requires the business audit migration used by sales routes");
    return;
  }

  const suffix = randomUUID();
  const actorEmail = `customer-quote-email-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  let releaseFirstSend!: () => void;
  let markFirstSendStarted!: () => void;
  const firstSendGate = new Promise<void>((resolve) => { releaseFirstSend = resolve; });
  const firstSendStarted = new Promise<void>((resolve) => { markFirstSendStarted = resolve; });
  let releaseOlderRetry!: () => void;
  let markOlderRetryStarted!: () => void;
  const olderRetryGate = new Promise<void>((resolve) => { releaseOlderRetry = resolve; });
  const olderRetryStarted = new Promise<void>((resolve) => { markOlderRetryStarted = resolve; });
  let releaseNewerRetry!: () => void;
  let markNewerRetryStarted!: () => void;
  const newerRetryGate = new Promise<void>((resolve) => { releaseNewerRetry = resolve; });
  const newerRetryStarted = new Promise<void>((resolve) => { markNewerRetryStarted = resolve; });
  const sendAttempts: string[] = [];
  let staleQuoteSendAttempts = 0;
  registerSalesRoutes(app, owner, {
    sendCustomerQuoteEmail: async (content) => {
      sendAttempts.push(content.quoteNumber);
      if (content.quoteNumber.endsWith("-A")) {
        markFirstSendStarted();
        await firstSendGate;
        return { ok: true, messageId: `gmail-${suffix}-sent` };
      }
      if (content.quoteNumber.endsWith("-C")) {
        staleQuoteSendAttempts += 1;
        if (staleQuoteSendAttempts === 1) {
          markOlderRetryStarted();
          await olderRetryGate;
          return { ok: false, error: "An older attempt failed." };
        }
        markNewerRetryStarted();
        await newerRetryGate;
        return { ok: true, messageId: `gmail-${suffix}-latest` };
      }
      return { ok: false, error: "Gmail could not send the quote (HTTP 503)" };
    },
  });
  app.use(((error: unknown, _req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  }) as express.ErrorRequestHandler);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let customerId: number | undefined;
  let productId: number | undefined;
  const quoteIds: number[] = [];
  const send = async (quoteId: number, body: Record<string, unknown> = {}) => {
    const response = await fetch(`${baseUrl}/api/customer-quotes/${quoteId}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() as Record<string, any> };
  };

  try {
    const [customer] = await db.insert(customers).values({
      name: `Quote email customer ${suffix}`,
      email: `quote-email-${suffix}@example.test`,
      status: "active",
    }).returning();
    customerId = customer.id;
    const [product] = await db.insert(products).values({
      sku: `CQEM-${suffix}`,
      name: `Quote email product ${suffix}`,
      status: "active",
    }).returning();
    productId = product.id;

    const createQuote = async (ending: string) => {
      const [quote] = await db.insert(customerQuotes).values({
        quoteNumber: `CQ-${suffix.slice(0, 30)}-${ending}`,
        customerId: customer.id,
        validUntil: "2999-12-31",
      }).returning();
      quoteIds.push(quote.id);
      await db.insert(customerQuoteLines).values({
        customerQuoteId: quote.id,
        productId: product.id,
        quantity: 2,
        unitPriceZmw: "25.00",
      });
      return quote;
    };

    const concurrentQuote = await createQuote("A");
    const firstRequest = send(concurrentQuote.id);
    await firstSendStarted;
    const overlappingRequest = await send(concurrentQuote.id);
    assert.equal(overlappingRequest.status, 409, JSON.stringify(overlappingRequest.payload));
    assert.match(overlappingRequest.payload.error, /already being sent/i);
    assert.equal(sendAttempts.filter((number) => number === concurrentQuote.quoteNumber).length, 1);
    releaseFirstSend();
    const firstResponse = await firstRequest;
    assert.equal(firstResponse.status, 200, JSON.stringify(firstResponse.payload));

    const staleQuote = await createQuote("B");
    const staleAttemptAt = new Date(Date.now() - 6 * 60 * 1000);
    await db.update(customerQuotes).set({
      emailSendStatus: "sending",
      emailAttemptedAt: staleAttemptAt,
    }).where(eq(customerQuotes.id, staleQuote.id));
    for (const body of [{}, {}]) {
      const unconfirmed = await send(staleQuote.id, body);
      assert.equal(unconfirmed.status, 409, JSON.stringify(unconfirmed.payload));
      assert.match(unconfirmed.payload.error, /confirm before retrying/i);
    }
    const [stillUnresolved] = await db.select().from(customerQuotes)
      .where(eq(customerQuotes.id, staleQuote.id));
    assert.equal(stillUnresolved?.emailSendStatus, "sending");
    assert.equal(stillUnresolved?.emailAttemptedAt?.getTime(), staleAttemptAt.getTime());
    assert.equal(sendAttempts.includes(staleQuote.quoteNumber), false);

    const confirmedRetry = await send(staleQuote.id, { confirmAmbiguousRetry: true });
    assert.equal(confirmedRetry.status, 502, JSON.stringify(confirmedRetry.payload));
    assert.equal(sendAttempts.filter((number) => number === staleQuote.quoteNumber).length, 1);

    const [savedSuccess] = await db.select().from(customerQuotes)
      .where(eq(customerQuotes.id, concurrentQuote.id));
    assert.equal(savedSuccess?.emailSendStatus, "sent");
    assert.equal(savedSuccess?.emailProviderMessageId, `gmail-${suffix}-sent`);
    assert.ok(savedSuccess?.emailSentAt);
    assert.equal(savedSuccess?.emailSendError, null);

    const [savedFailure] = await db.select().from(customerQuotes)
      .where(eq(customerQuotes.id, staleQuote.id));
    assert.equal(savedFailure?.emailSendStatus, "failed");
    assert.equal(savedFailure?.emailProviderMessageId, null);
    assert.equal(savedFailure?.emailSentAt, null);
    assert.equal(savedFailure?.emailSendError, "Gmail could not send the quote (HTTP 503)");
    assert.ok(savedFailure?.emailAttemptedAt);

    const retriedQuote = await createQuote("C");
    const staleStartedAt = new Date(Date.now() - 6 * 60 * 1000);
    await db.update(customerQuotes).set({
      emailSendStatus: "sending",
      emailAttemptedAt: staleStartedAt,
    }).where(eq(customerQuotes.id, retriedQuote.id));
    const olderRequest = send(retriedQuote.id, { confirmAmbiguousRetry: true });
    await olderRetryStarted;
    await db.update(customerQuotes).set({ emailAttemptedAt: staleStartedAt })
      .where(eq(customerQuotes.id, retriedQuote.id));
    const newerRequest = send(retriedQuote.id, { confirmAmbiguousRetry: true });
    await newerRetryStarted;

    releaseOlderRetry();
    const outdatedResponse = await olderRequest;
    assert.equal(outdatedResponse.status, 409, JSON.stringify(outdatedResponse.payload));
    const [latestClaim] = await db.select().from(customerQuotes)
      .where(eq(customerQuotes.id, retriedQuote.id));
    assert.equal(latestClaim?.emailSendStatus, "sending");
    assert.ok(latestClaim?.emailAttemptedAt && latestClaim.emailAttemptedAt > staleStartedAt);

    releaseNewerRetry();
    const latestResponse = await newerRequest;
    assert.equal(latestResponse.status, 200, JSON.stringify(latestResponse.payload));
    const [latestSaved] = await db.select().from(customerQuotes)
      .where(eq(customerQuotes.id, retriedQuote.id));
    assert.equal(latestSaved?.emailSendStatus, "sent");
    assert.equal(latestSaved?.emailProviderMessageId, `gmail-${suffix}-latest`);
    assert.ok(latestSaved?.emailSentAt);
    assert.equal(latestSaved?.emailSendError, null);
  } finally {
    releaseFirstSend();
    releaseOlderRetry();
    releaseNewerRetry();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      if (quoteIds.length) {
        await client.query("DELETE FROM customer_quote_lines WHERE customer_quote_id = ANY($1::int[])", [quoteIds]);
        await client.query("DELETE FROM customer_quotes WHERE id = ANY($1::int[])", [quoteIds]);
      }
      if (productId) await client.query("DELETE FROM products WHERE id = $1", [productId]);
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
