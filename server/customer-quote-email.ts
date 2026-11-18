import { ReplitConnectors } from "@replit/connectors-sdk";

export type CustomerQuoteEmailContent = {
  quoteNumber: string;
  customerName: string;
  customerEmail: string;
  validUntil: string | null;
  deliveryAddress: string | null;
  notes: string | null;
  totalZmw: string;
  lines: {
    productName: string;
    sku: string;
    quantity: number;
    unitPriceZmw: string;
    lineTotalZmw: string;
  }[];
};

type GmailProxy = Pick<ReplitConnectors, "proxy">;

function formatMoney(value: string) {
  const [whole = "0", fraction = ""] = value.split(".");
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `ZMW ${groupedWhole}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

function wrapBase64(value: string) {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

export function buildCustomerQuoteEmail(content: CustomerQuoteEmailContent) {
  const safeQuoteNumber = content.quoteNumber.replace(/[\r\n]+/g, " ").slice(0, 100);
  const itemLines = content.lines.map((line) =>
    `- ${line.productName} (${line.sku}): ${line.quantity} × ${formatMoney(line.unitPriceZmw)} = ${formatMoney(line.lineTotalZmw)}`,
  );
  const body = [
    `Dear ${content.customerName},`,
    "",
    `Please find the details of your quotation ${safeQuoteNumber} below.`,
    content.validUntil ? `Valid until: ${content.validUntil}` : "This quote has no expiry date.",
    "",
    "Quoted items:",
    ...itemLines,
    "",
    `Total: ${formatMoney(content.totalZmw)}`,
    ...(content.deliveryAddress ? ["", `Delivery address: ${content.deliveryAddress}`] : []),
    ...(content.notes ? ["", `Notes: ${content.notes}`] : []),
    "",
    "All prices are in ZMW.",
    "",
    "Kind regards,",
    "Trace and Tether Craft Studio Limited",
  ].join("\n");
  const encodedBody = wrapBase64(Buffer.from(body, "utf8").toString("base64"));
  const raw = [
    `To: ${content.customerEmail}`,
    `Subject: Customer quote ${safeQuoteNumber}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody,
  ].join("\r\n");
  return Buffer.from(raw, "utf8").toString("base64url");
}

function providerMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return null;
}

export async function sendCustomerQuoteEmail(
  content: CustomerQuoteEmailContent,
  gmail: GmailProxy = new ReplitConnectors(),
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  timeout.unref?.();
  try {
    const response = await gmail.proxy("google-mail", "/gmail/v1/users/me/messages/send", {
      method: "POST",
      body: { raw: buildCustomerQuoteEmail(content) },
      signal: controller.signal,
    });
    if (response.ok) {
      let messageId: unknown;
      try {
        const result: unknown = await response.json();
        if (result && typeof result === "object" && "id" in result) {
          messageId = (result as { id?: unknown }).id;
        }
      } catch {
        messageId = null;
      }
      if (typeof messageId === "string" && messageId.trim() && messageId.trim().length <= 255) {
        return { ok: true, messageId: messageId.trim() };
      }
      return {
        ok: false,
        error: "Gmail accepted the email but did not return a message reference. Check Gmail Sent before retrying.",
      };
    }

    const responseText = await response.text().catch(() => "");
    let details: string | null = null;
    try {
      details = providerMessage(JSON.parse(responseText));
    } catch {
      details = null;
    }
    const suffix = details ? `: ${details.replace(/[\r\n]+/g, " ").slice(0, 300)}` : "";
    return { ok: false, error: `Gmail could not send the quote (HTTP ${response.status})${suffix}` };
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") {
      return { ok: false, error: "Gmail did not confirm whether the email was sent. Check Gmail Sent before retrying." };
    }
    const detail = cause instanceof Error ? cause.message.replace(/[\r\n]+/g, " ").slice(0, 300) : "";
    return {
      ok: false,
      error: detail ? `Gmail could not send the quote: ${detail}` : "Gmail could not send the quote. Check the Gmail connection and try again.",
    };
  } finally {
    clearTimeout(timeout);
  }
}
