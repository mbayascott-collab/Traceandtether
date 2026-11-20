import { and, eq } from "drizzle-orm";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { customerQuoteEmailAttempts, customerQuotes } from "../shared/schema";
import { db } from "./db";

const bounceSearch = "newer_than:7d {from:mailer-daemon from:postmaster}";
const bounceBatchSize = 100;
const pollIntervalMs = 2 * 60 * 1000;

type GmailProxy = Pick<ReplitConnectors, "proxy">;

type GmailPayload = {
  headers?: unknown;
  body?: { data?: unknown };
  parts?: GmailPayload[];
};

type GmailMessage = {
  id?: unknown;
  internalDate?: unknown;
  payload?: GmailPayload;
};

type GmailBounce = {
  quoteNumber: string;
  attemptedAt: Date;
  error: string | null;
};

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function decodeGmailPart(value: unknown): string {
  return typeof value === "string" ? decodeBase64Url(value) : "";
}

function collectPayloadText(payload: GmailPayload | undefined): string[] {
  if (!payload) return [];
  return [
    decodeGmailPart(payload.body?.data),
    ...(Array.isArray(payload.parts) ? payload.parts.flatMap(collectPayloadText) : []),
  ].filter(Boolean);
}

function payloadHeaders(payload: GmailPayload | undefined): string {
  if (!payload || !Array.isArray(payload.headers)) return "";
  return payload.headers
    .filter((header): header is { name: string; value: string } =>
      !!header && typeof header === "object"
      && typeof (header as { name?: unknown }).name === "string"
      && typeof (header as { value?: unknown }).value === "string")
    .map((header) => `${header.name}: ${header.value}`)
    .join("\n");
}

function headerValue(text: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^${escapedName}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? null;
}

export function parseGmailQuoteBounce(message: GmailMessage): GmailBounce | null {
  const payload = message.payload;
  const textParts = collectPayloadText(payload);
  const source = [payloadHeaders(payload), ...textParts].join("\n");
  const hasDsnReport = /message\/delivery-status/i.test(source)
    || (/Final-Recipient\s*:/i.test(source) && /Action\s*:\s*failed/i.test(source));
  const hasPermanentFailure = /Action\s*:\s*failed/i.test(source) && /Status\s*:\s*5\.\d{1,3}\.\d{1,3}/i.test(source);
  if (!hasDsnReport || !hasPermanentFailure) return null;

  const quoteNumber = headerValue(source, "X-Trace-Tether-Quote-Number");
  const attemptedAtText = headerValue(source, "X-Trace-Tether-Email-Attempt");
  if (!quoteNumber || !attemptedAtText) return null;
  const attemptedAt = new Date(attemptedAtText);
  if (Number.isNaN(attemptedAt.getTime())) return null;

  const diagnostic = headerValue(source, "Diagnostic-Code");
  return {
    quoteNumber: quoteNumber.slice(0, 40),
    attemptedAt,
    error: diagnostic?.replace(/[\r\n]+/g, " ").slice(0, 500) ?? "Gmail reported a permanent delivery failure.",
  };
}

async function gmailJson<T>(gmail: GmailProxy, path: string): Promise<T> {
  const response = await gmail.proxy("google-mail", path, { method: "GET" });
  if (!response.ok) throw new Error(`Gmail API request failed (HTTP ${response.status}).`);
  return await response.json() as T;
}

async function forwardBounceEvent(input: {
  messageId: string;
  occurredAt: Date;
  quoteNumber: string;
  attemptedAt: Date;
  error: string | null;
  secret: string;
  port: number;
}): Promise<boolean> {
  const [quote] = await db.select({
    id: customerQuotes.id,
    emailProviderMessageId: customerQuotes.emailProviderMessageId,
    emailSendStatus: customerQuotes.emailSendStatus,
    emailAttemptedAt: customerQuotes.emailAttemptedAt,
  }).from(customerQuotes).where(eq(customerQuotes.quoteNumber, input.quoteNumber)).limit(1);
  if (!quote) return false;
  let messageId = quote.emailAttemptedAt?.getTime() === input.attemptedAt.getTime()
    && ["sent", "bounced"].includes(quote.emailSendStatus)
    ? quote.emailProviderMessageId
    : null;
  if (!messageId) {
    const [attempt] = await db.select({
      providerMessageId: customerQuoteEmailAttempts.providerMessageId,
      status: customerQuoteEmailAttempts.status,
    }).from(customerQuoteEmailAttempts).where(and(
      eq(customerQuoteEmailAttempts.customerQuoteId, quote.id),
      eq(customerQuoteEmailAttempts.attemptedAt, input.attemptedAt),
    )).limit(1);
    if (attempt && ["sent", "delivered", "bounced"].includes(attempt.status)) {
      messageId = attempt.providerMessageId;
    }
  }
  if (!messageId) return false;

  const response = await fetch(`http://127.0.0.1:${input.port}/api/webhooks/customer-quote-email`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      provider: "gmail",
      eventId: input.messageId,
      messageId,
      status: "bounced",
      occurredAt: input.occurredAt.toISOString(),
      error: input.error,
    }),
  });
  if (!response.ok) throw new Error(`Quote delivery webhook rejected a Gmail bounce (HTTP ${response.status}).`);
  return true;
}

export async function scanGmailQuoteBounceMailbox(input: {
  webhookSecret: string;
  port?: number;
  gmail?: GmailProxy;
  now?: Date;
}): Promise<number> {
  const gmail = input.gmail ?? new ReplitConnectors();
  const query = new URLSearchParams({ q: bounceSearch, maxResults: String(bounceBatchSize) });
  const listed = await gmailJson<{ messages?: { id?: string }[] }>(
    gmail,
    `/gmail/v1/users/me/messages?${query.toString()}`,
  );
  const messages = (listed.messages ?? []).filter((item): item is { id: string } =>
    typeof item?.id === "string");
  let applied = 0;
  for (const item of messages) {
    const message = await gmailJson<GmailMessage>(
      gmail,
      `/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`,
    );
    const bounce = parseGmailQuoteBounce(message);
    if (!bounce) continue;
    const gmailMessageId = typeof message.id === "string" ? message.id : item.id;
    const timestamp = Number(message.internalDate);
    const occurredAt = Number.isFinite(timestamp) ? new Date(timestamp) : (input.now ?? new Date());
    if (Number.isNaN(occurredAt.getTime())) continue;
    if (await forwardBounceEvent({
      messageId: gmailMessageId,
      occurredAt,
      ...bounce,
      secret: input.webhookSecret,
      port: input.port ?? Number(process.env.PORT ?? 5000),
    })) applied += 1;
  }
  return applied;
}

export function startGmailQuoteBouncePolling(webhookSecret: string): void {
  let scanInProgress = false;
  const scan = async () => {
    if (scanInProgress) return;
    scanInProgress = true;
    try {
      const count = await scanGmailQuoteBounceMailbox({ webhookSecret });
      if (count > 0) console.info(`Applied ${count} Gmail customer quote bounce notice${count === 1 ? "" : "s"}.`);
    } catch (error) {
      console.error(
        "Gmail customer quote bounce scan failed.",
        error instanceof Error ? error.message : "Unknown error",
      );
    } finally {
      scanInProgress = false;
    }
  };
  void scan();
  const interval = setInterval(() => void scan(), pollIntervalMs);
  interval.unref?.();
}
