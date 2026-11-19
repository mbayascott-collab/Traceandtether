import { randomUUID } from "node:crypto";
import { ReplitConnectors } from "@replit/connectors-sdk";

export type CustomerQuoteEmailContent = {
  quoteNumber: string;
  emailAttemptedAt?: string;
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

function toWinAnsi(value: string) {
  const specialCharacters: Record<string, number> = {
    "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87,
    "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91,
    "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98,
    "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
  };
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0x20 && codePoint <= 0xff && !(codePoint >= 0x7f && codePoint <= 0x9f)) {
      return codePoint;
    }
    return specialCharacters[character] ?? 0x3f;
  });
}

function escapePdfText(value: string) {
  return toWinAnsi(value.replace(/[\r\n\t]+/g, " ").replace(/[^\S ]+/g, " "))
    .map((byte) => byte === 0x28 || byte === 0x29 || byte === 0x5c ? `\\${String.fromCharCode(byte)}` : String.fromCharCode(byte))
    .join("");
}

function wrapText(value: string, maxLength = 92) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > maxLength) {
      if (current) lines.push(current);
      current = "";
      for (let start = 0; start < word.length; start += maxLength) {
        const chunk = word.slice(start, start + maxLength);
        if (start + maxLength >= word.length) current = chunk;
        else lines.push(chunk);
      }
      continue;
    }
    if (current && `${current} ${word}`.length > maxLength) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function pdfObject(value: string | Buffer) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, "latin1");
}

export function buildCustomerQuotePdf(content: CustomerQuoteEmailContent) {
  const lines = [
    "TRACE AND TETHER CRAFT STUDIO LIMITED",
    "CUSTOMER QUOTATION",
    `Quote number: ${content.quoteNumber}`,
    `Prepared for: ${content.customerName}`,
    `Valid until: ${content.validUntil || "No expiry date"}`,
    ...(content.deliveryAddress ? [`Delivery address: ${content.deliveryAddress}`] : []),
    "",
    "QUOTED ITEMS",
  ];
  for (const [index, line] of content.lines.entries()) {
    lines.push(...wrapText(`${index + 1}. ${line.productName} (SKU: ${line.sku})`));
    lines.push(`   Quantity: ${line.quantity}    Unit price: ${formatMoney(line.unitPriceZmw)}    Amount: ${formatMoney(line.lineTotalZmw)}`);
  }
  lines.push("", `TOTAL: ${formatMoney(content.totalZmw)}`);
  if (content.notes) lines.push("", ...wrapText(`Notes: ${content.notes}`));
  lines.push("", "All prices are in ZMW.");

  const pageLines: string[][] = [];
  const firstPageCapacity = 54;
  const nextPageCapacity = 56;
  pageLines.push(lines.slice(0, firstPageCapacity));
  for (let offset = firstPageCapacity; offset < lines.length; offset += nextPageCapacity) {
    pageLines.push([`Customer quotation ${content.quoteNumber} (continued)`, ...lines.slice(offset, offset + nextPageCapacity - 1)]);
  }

  const objects: Buffer[] = [];
  const pageRefs = pageLines.map((_, index) => `${4 + index * 2} 0 R`).join(" ");
  objects.push(pdfObject("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(pdfObject(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pageLines.length} >>`));
  objects.push(pdfObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"));
  pageLines.forEach((page, index) => {
    const pageObjectNumber = 4 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    const commands = [
      "BT",
      "/F1 10 Tf",
      "48 790 Td",
      ...page.flatMap((line, lineIndex) => [
        `(${escapePdfText(line)}) Tj`,
        ...(lineIndex < page.length - 1 ? ["0 -13 Td"] : []),
      ]),
      "ET",
    ].join("\n");
    const stream = Buffer.from(commands, "latin1");
    objects.push(pdfObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`,
    ));
    objects.push(Buffer.concat([
      pdfObject(`<< /Length ${stream.length} >>\nstream\n`),
      stream,
      pdfObject("\nendstream"),
    ]));
  });

  const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const chunks = [header];
  const offsets = [0];
  let byteOffset = header.length;
  objects.forEach((object, index) => {
    offsets.push(byteOffset);
    const wrappedObject = Buffer.concat([
      pdfObject(`${index + 1} 0 obj\n`), object, pdfObject("\nendobj\n"),
    ]);
    chunks.push(wrappedObject);
    byteOffset += wrappedObject.length;
  });
  const xrefOffset = byteOffset;
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n");
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}

function buildCustomerQuoteEmailWithPdf(content: CustomerQuoteEmailContent, pdf: Buffer) {
  const safeQuoteNumber = content.quoteNumber.replace(/[\r\n]+/g, " ").slice(0, 100);
  const safeAttemptedAt = content.emailAttemptedAt?.replace(/[\r\n]+/g, "").slice(0, 40);
  const attachmentName = safeQuoteNumber.replace(/[^A-Za-z0-9._-]+/g, "_") || "customer-quote";
  const boundary = `customer-quote-${randomUUID()}`;
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
  const raw = [
    `To: ${content.customerEmail}`,
    `Subject: Customer quote ${safeQuoteNumber}`,
    `X-Trace-Tether-Quote-Number: ${safeQuoteNumber}`,
    ...(safeAttemptedAt ? [`X-Trace-Tether-Email-Attempt: ${safeAttemptedAt}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(body, "utf8").toString("base64")),
    `--${boundary}`,
    `Content-Type: application/pdf; name="${attachmentName}.pdf"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${attachmentName}.pdf"`,
    "",
    wrapBase64(pdf.toString("base64")),
    `--${boundary}--`,
  ].join("\r\n");
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function buildCustomerQuoteEmail(content: CustomerQuoteEmailContent) {
  return buildCustomerQuoteEmailWithPdf(content, buildCustomerQuotePdf(content));
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
  generatePdf: (content: CustomerQuoteEmailContent) => Buffer = buildCustomerQuotePdf,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  let raw: string;
  try {
    const pdf = generatePdf(content);
    raw = buildCustomerQuoteEmailWithPdf(content, pdf);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.replace(/[\r\n]+/g, " ").slice(0, 300) : "";
    return {
      ok: false,
      error: detail ? `Could not prepare the printable quote PDF: ${detail}` : "Could not prepare the printable quote PDF.",
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  timeout.unref?.();
  try {
    const response = await gmail.proxy("google-mail", "/gmail/v1/users/me/messages/send", {
      method: "POST",
      body: { raw },
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
