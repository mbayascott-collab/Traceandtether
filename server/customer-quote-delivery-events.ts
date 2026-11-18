import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const customerQuoteDeliveryEventSchema = z.object({
  provider: z.literal("gmail"),
  eventId: z.string().trim().min(1).max(255),
  messageId: z.string().trim().min(1).max(255),
  status: z.enum(["delivered", "bounced", "failed"]),
  occurredAt: z.string().datetime({ offset: true }),
  error: z.string().trim().max(500).nullable().optional(),
}).strict();

export type CustomerQuoteDeliveryEvent = z.infer<typeof customerQuoteDeliveryEventSchema>;

export function hasValidDeliveryWebhookToken(
  authorizationHeader: string | undefined,
  configuredSecret: string | undefined,
): boolean {
  if (!configuredSecret || !authorizationHeader?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorizationHeader.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(configuredSecret, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function isValidCustomerQuoteDeliveryEventTime(
  event: CustomerQuoteDeliveryEvent,
  now = new Date(),
): boolean {
  const occurredAt = new Date(event.occurredAt);
  return !Number.isNaN(occurredAt.getTime())
    && occurredAt.getTime() <= now.getTime() + 5 * 60 * 1000;
}

export function shouldApplyCustomerQuoteDeliveryEvent(input: {
  currentMessageId: string | null;
  lastEventAt: Date | null;
  event: CustomerQuoteDeliveryEvent;
  now?: Date;
}): boolean {
  if (!input.currentMessageId || input.currentMessageId !== input.event.messageId) return false;
  const occurredAt = new Date(input.event.occurredAt);
  if (!isValidCustomerQuoteDeliveryEventTime(input.event, input.now)) return false;
  return !input.lastEventAt || occurredAt.getTime() > input.lastEventAt.getTime();
}
