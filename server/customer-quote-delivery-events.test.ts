import assert from "node:assert/strict";
import test from "node:test";
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
