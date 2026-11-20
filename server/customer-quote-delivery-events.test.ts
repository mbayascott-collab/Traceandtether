import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { businessAuditLogs, customerQuoteEmailAttempts, customerQuoteEmailEvents, customers, customerQuotes, unmatchedCustomerQuoteEmailEvents } from "../shared/schema";
import {
  customerQuoteDeliveryEventSchema, hasValidDeliveryWebhookToken,
  isValidCustomerQuoteDeliveryEventTime, shouldApplyCustomerQuoteDeliveryEvent,
} from "./customer-quote-delivery-events";

const now = new Date("2026-11-18T12:00:00.000Z");
const validSecret = "correct-secret-with-at-least-32-characters";
const event = customerQuoteDeliveryEventSchema.parse({
  provider: "gmail",
  eventId: "event-1",
  messageId: "message-1",
  status: "delivered",
  occurredAt: "2026-11-18T11:59:00.000Z",
});

test("requires an authenticated provider event and rejects malformed payloads", () => {
  assert.equal(hasValidDeliveryWebhookToken(`Bearer ${validSecret}`, validSecret), true);
  assert.equal(hasValidDeliveryWebhookToken("Bearer wrong-secret", validSecret), false);
  assert.equal(hasValidDeliveryWebhookToken(undefined, validSecret), false);
  assert.equal(hasValidDeliveryWebhookToken("Bearer correct-secret", undefined), false);
  assert.equal(hasValidDeliveryWebhookToken("Bearer short-secret", "short-secret"), false);
  assert.equal(customerQuoteDeliveryEventSchema.safeParse({ ...event, status: "queued" }).success, false);
  assert.equal(customerQuoteDeliveryEventSchema.safeParse({ ...event, unexpected: true }).success, false);
});

test("only applies events for the current send and with a strictly newer timestamp", () => {
  assert.equal(shouldApplyCustomerQuoteDeliveryEvent({
    currentMessageId: "message-1", lastEventAt: null, event, now,
  }), true);
  assert.equal(shouldApplyCustomerQuoteDeliveryEvent({
    currentMessageId: "older-message", lastEventAt: null, event, now,
  }), false);
  assert.equal(shouldApplyCustomerQuoteDeliveryEvent({
    currentMessageId: "message-1", lastEventAt: new Date(event.occurredAt), event, now,
  }), false);
  const older = { ...event, occurredAt: "2026-11-18T11:58:00.000Z" };
  assert.equal(shouldApplyCustomerQuoteDeliveryEvent({
    currentMessageId: "message-1", lastEventAt: new Date(event.occurredAt), event: older, now,
  }), false);
});

test("rejects delivery events with timestamps too far in the future", () => {
  const future = { ...event, occurredAt: "2026-11-18T12:06:00.000Z" };
  assert.equal(isValidCustomerQuoteDeliveryEventTime(future, now), false);
  assert.equal(shouldApplyCustomerQuoteDeliveryEvent({
    currentMessageId: "message-1", lastEventAt: null, event: future, now,
  }), false);
});

test("customer quote delivery webhook persists replays and orders concurrent events in PostgreSQL", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerSalesRoutes }] = await Promise.all([
    import("./db"),
    import("./sales-routes"),
  ]);
  const migrationTables = await pool.query<{ events: string | null; audits: string | null; histories: string | null }>(
    `SELECT to_regclass('public.customer_quote_email_events') AS events,
            to_regclass('public.business_audit_logs') AS audits,
            to_regclass('public.unmatched_customer_quote_email_events') AS histories`,
  );
  if (!migrationTables.rows[0]?.events || !migrationTables.rows[0]?.audits || !migrationTables.rows[0]?.histories) {
    t.skip("requires the customer quote delivery event, unmatched notice, and audit migrations");
    await pool.end();
    return;
  }

  const suffix = randomUUID();
  const webhookSecret = `delivery-event-test-${suffix}-secret-long-enough`;
  const actorEmail = `delivery-event-test-${suffix}@example.test`;
  process.env.CUSTOMER_QUOTE_EMAIL_WEBHOOK_SECRET = webhookSecret;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `delivery-event-test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerSalesRoutes(app, owner);
  app.use(((error: unknown, _req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  }) as express.ErrorRequestHandler);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const quoteIds: number[] = [];
  let unmatchedEventId: number | undefined;
  let customerId: number | undefined;
  const postEvent = async (payload: Record<string, unknown>) => {
    const response = await fetch(`${baseUrl}/api/webhooks/customer-quote-email`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${webhookSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return { status: response.status, payload: await response.json() as Record<string, any> };
  };

  try {
    const [customer] = await db.insert(customers).values({
      name: `Delivery event customer ${suffix}`,
    }).returning();
    customerId = customer.id;

    const createQuote = async (attempt: string) => {
      const [quote] = await db.insert(customerQuotes).values({
        quoteNumber: `CQ-${suffix.slice(0, 20)}-${attempt}`,
        customerId: customer.id,
        emailSendStatus: "sent",
        emailProviderMessageId: `gmail-${suffix}-${attempt}`,
      }).returning();
      quoteIds.push(quote.id);
      return quote;
    };

    const replayQuote = await createQuote("replay");
    const replayEvent = {
      provider: "gmail",
      eventId: `event-${suffix}-replay`,
      messageId: replayQuote.emailProviderMessageId!,
      status: "delivered",
      occurredAt: new Date(Date.now() - 120_000).toISOString(),
    };
    const replayResults = await Promise.all([
      postEvent(replayEvent),
      postEvent(replayEvent),
    ]);
    assert.deepEqual(replayResults.map((result) => result.status), [200, 200]);
    assert.equal(replayResults.filter((result) => result.payload.applied === true).length, 1);
    assert.equal(replayResults.filter((result) => result.payload.duplicate === true).length, 1);

    const changedReplay = await postEvent({
      ...replayEvent,
      status: "bounced",
      occurredAt: new Date(Date.now() - 30_000).toISOString(),
      error: "A conflicting replay must not replace the original event.",
    });
    assert.equal(changedReplay.status, 200, JSON.stringify(changedReplay.payload));
    assert.equal(changedReplay.payload.duplicate, true);
    const [savedReplay] = await db.select().from(customerQuotes)
      .where(eq(customerQuotes.id, replayQuote.id));
    assert.equal(savedReplay?.emailSendStatus, "delivered");
    assert.equal(savedReplay?.emailDeliveryEventAt?.toISOString(), replayEvent.occurredAt);
    assert.equal(savedReplay?.emailSendError, null);
    const savedReplayEvents = await db.select().from(customerQuoteEmailEvents)
      .where(eq(customerQuoteEmailEvents.customerQuoteId, replayQuote.id));
    assert.equal(savedReplayEvents.length, 1);
    assert.equal(savedReplayEvents[0]?.outcome, "delivered");
    const replayAudits = await db.select().from(businessAuditLogs).where(and(
      eq(businessAuditLogs.entityType, "customer_quote"),
      eq(businessAuditLogs.entityId, replayQuote.id),
    ));
    assert.equal(replayAudits.length, 1, "a replay must not write a second quote update audit");

    const orderedQuote = await createQuote("ordered");
    const olderEvent = {
      provider: "gmail",
      eventId: `event-${suffix}-older`,
      messageId: orderedQuote.emailProviderMessageId!,
      status: "bounced",
      occurredAt: new Date(Date.now() - 120_000).toISOString(),
      error: "Older event",
    };
    const newerEvent = {
      ...olderEvent,
      eventId: `event-${suffix}-newer`,
      status: "delivered",
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const concurrentResults = await Promise.all([
      postEvent(olderEvent),
      postEvent(newerEvent),
    ]);
    assert.deepEqual(concurrentResults.map((result) => result.status), [200, 200]);
    const [savedOrdered] = await db.select().from(customerQuotes)
      .where(eq(customerQuotes.id, orderedQuote.id));
    assert.equal(savedOrdered?.emailSendStatus, "delivered");
    assert.equal(savedOrdered?.emailDeliveryEventAt?.toISOString(), newerEvent.occurredAt);
    assert.equal(savedOrdered?.emailSendError, null);
    const orderedEvents = await db.select().from(customerQuoteEmailEvents)
      .where(eq(customerQuoteEmailEvents.customerQuoteId, orderedQuote.id));
    assert.equal(orderedEvents.length, 2);

    const retriedQuote = await createQuote("current");
    const priorAttemptAt = new Date(Date.now() - 90_000);
    await db.insert(customerQuoteEmailAttempts).values({
      customerQuoteId: retriedQuote.id, attemptNumber: 1, attemptedAt: priorAttemptAt,
      recipientEmail: `delivery-event-test-${suffix}@example.test`, status: "sent",
      sentAt: priorAttemptAt, providerMessageId: `gmail-${suffix}-previous-attempt`,
    });
    await db.update(customerQuotes).set({
      emailProviderMessageId: `gmail-${suffix}-current-attempt`,
      emailSendStatus: "sent",
      emailAttemptedAt: new Date(),
    }).where(eq(customerQuotes.id, retriedQuote.id));
    const earlierAttempt = await postEvent({
      provider: "gmail",
      eventId: `event-${suffix}-old-attempt`,
      messageId: `gmail-${suffix}-previous-attempt`,
      status: "bounced",
      occurredAt: new Date(Date.now() - 30_000).toISOString(),
      error: "An earlier send attempt bounced.",
    });
    assert.equal(earlierAttempt.status, 200);
    assert.equal(earlierAttempt.payload.stale, true);
    const [savedCurrentAttempt] = await db.select().from(customerQuotes)
      .where(eq(customerQuotes.id, retriedQuote.id));
    assert.equal(savedCurrentAttempt?.emailSendStatus, "sent");
    assert.equal(savedCurrentAttempt?.emailProviderMessageId, `gmail-${suffix}-current-attempt`);
    assert.equal(savedCurrentAttempt?.emailDeliveryEventAt, null);
    assert.equal(savedCurrentAttempt?.emailSendError, null);
    const oldAttemptEvents = await db.select().from(customerQuoteEmailEvents)
      .where(eq(customerQuoteEmailEvents.customerQuoteId, retriedQuote.id));
    assert.equal(oldAttemptEvents.length, 1);
    const [savedOldAttempt] = await db.select().from(customerQuoteEmailAttempts)
      .where(eq(customerQuoteEmailAttempts.providerMessageId, `gmail-${suffix}-previous-attempt`));
    assert.equal(savedOldAttempt?.status, "bounced");

    const unknownNotice = await postEvent({
      provider: "gmail",
      eventId: `event-${suffix}-unknown`,
      messageId: `gmail-${suffix}-unknown`,
      status: "bounced",
      occurredAt: new Date(Date.now() - 15_000).toISOString(),
      error: "The notice could not be correlated to an attempt.",
    });
    assert.equal(unknownNotice.status, 200);
    assert.equal(unknownNotice.payload.unmatched, true);
    const [savedUnmatchedNotice] = await db.select().from(unmatchedCustomerQuoteEmailEvents)
      .where(eq(unmatchedCustomerQuoteEmailEvents.providerEventId, `event-${suffix}-unknown`));
    assert.equal(savedUnmatchedNotice?.providerMessageId, `gmail-${suffix}-unknown`);
    assert.equal(savedUnmatchedNotice?.outcome, "bounced");
    unmatchedEventId = savedUnmatchedNotice?.id;
    const reviewResponse = await fetch(`${baseUrl}/api/customer-quote-email-notices/${unmatchedEventId}/reviewed`, {
      method: "PATCH",
    });
    assert.equal(reviewResponse.status, 200);
    const [reviewedNotice] = await db.select().from(unmatchedCustomerQuoteEmailEvents)
      .where(eq(unmatchedCustomerQuoteEmailEvents.id, unmatchedEventId!));
    assert.ok(reviewedNotice?.reviewedAt);
    assert.equal(reviewedNotice?.reviewedBy, actorEmail);
  } finally {
    delete process.env.CUSTOMER_QUOTE_EMAIL_WEBHOOK_SECRET;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (unmatchedEventId) {
        await client.query("DELETE FROM unmatched_customer_quote_email_events WHERE id = $1", [unmatchedEventId]);
      }
      if (quoteIds.length) {
        await client.query(
          "DELETE FROM business_audit_logs WHERE entity_type = 'customer_quote' AND entity_id = ANY($1::int[])",
          [quoteIds],
        );
        await client.query("DELETE FROM customer_quotes WHERE id = ANY($1::int[])", [quoteIds]);
      }
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
