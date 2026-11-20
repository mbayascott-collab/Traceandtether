import { randomUUID } from "node:crypto";
import { ReplitConnectors } from "@replit/connectors-sdk";

export type SalesDeliveryInvoiceEmailContent = {
  invoiceNumber: string;
  deliveryNumber: string;
  deliveryDate: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
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
  return `ZMW ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

function wrapBase64(value: string) {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function safeHeader(value: string, maxLength: number) {
  return value.replace(/[\r\n]+/g, " ").slice(0, maxLength);
}

function escapePdfText(value: string) {
  return value
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[()\\]/g, "\\$&");
}

export function buildSalesDeliveryInvoicePdf(content: SalesDeliveryInvoiceEmailContent) {
  const printableLines = [
    "TRACE AND TETHER CRAFT STUDIO LIMITED",
    "DELIVERY INVOICE",
    `Invoice number: ${content.invoiceNumber}`,
    `Delivery note: ${content.deliveryNumber}`,
    `Delivery date: ${content.deliveryDate}`,
    `Sales order: ${content.orderNumber}`,
    `Customer: ${content.customerName}`,
    "",
    "DELIVERED ITEMS",
    ...content.lines.flatMap((line, index) => [
      `${index + 1}. ${line.productName} (SKU: ${line.sku})`,
      `   Quantity: ${line.quantity}    Unit price: ${formatMoney(line.unitPriceZmw)}    Amount: ${formatMoney(line.lineTotalZmw)}`,
    ]),
    "",
    `TOTAL: ${formatMoney(content.totalZmw)}`,
    "",
    "All prices are in ZMW.",
  ];
  const pageLines: string[][] = [];
  for (let offset = 0; offset < printableLines.length; offset += 56) {
    pageLines.push(printableLines.slice(offset, offset + 56));
  }

  const objects: Buffer[] = [];
  const pageRefs = pageLines.map((_, index) => `${4 + index * 2} 0 R`).join(" ");
  objects.push(Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"));
  objects.push(Buffer.from(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pageLines.length} >>`, "latin1"));
  objects.push(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", "latin1"));
  pageLines.forEach((page, index) => {
    const pageObjectNumber = 4 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    const commands = [
      "BT", "/F1 10 Tf", "48 790 Td",
      ...page.flatMap((line, lineIndex) => [
        `(${escapePdfText(line)}) Tj`,
        ...(lineIndex < page.length - 1 ? ["0 -13 Td"] : []),
      ]),
      "ET",
    ].join("\n");
    const stream = Buffer.from(commands, "latin1");
    objects.push(Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`,
      "latin1",
    ));
    objects.push(Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "latin1"),
      stream,
      Buffer.from("\nendstream", "latin1"),
    ]));
  });

  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [0];
  let byteOffset = chunks[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(byteOffset);
    const wrapped = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "latin1"), object, Buffer.from("\nendobj\n", "latin1")]);
    chunks.push(wrapped);
    byteOffset += wrapped.length;
  });
  const xrefOffset = byteOffset;
  chunks.push(Buffer.from([
    "xref", `0 ${objects.length + 1}`, "0000000000 65535 f ",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer", `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref", String(xrefOffset), "%%EOF", "",
  ].join("\n"), "ascii"));
  return Buffer.concat(chunks);
}

export function buildSalesDeliveryInvoiceEmail(content: SalesDeliveryInvoiceEmailContent) {
  const invoiceNumber = safeHeader(content.invoiceNumber, 100);
  const deliveryNumber = safeHeader(content.deliveryNumber, 100);
  const customerName = safeHeader(content.customerName, 200);
  const attachmentName = invoiceNumber.replace(/[^A-Za-z0-9._-]+/g, "_") || "delivery-invoice";
  const boundary = `delivery-invoice-${randomUUID()}`;
  const body = [
    `Dear ${customerName},`,
    "",
    `Please find attached invoice ${invoiceNumber} for delivery ${deliveryNumber}.`,
    `Delivery date: ${safeHeader(content.deliveryDate, 20)}`,
    "",
    "Delivered items:",
    ...content.lines.map((line) =>
      `- ${line.productName} (${line.sku}): ${line.quantity} × ${formatMoney(line.unitPriceZmw)} = ${formatMoney(line.lineTotalZmw)}`,
    ),
    "",
    `Total: ${formatMoney(content.totalZmw)}`,
    "",
    "All prices are in ZMW.",
    "",
    "Kind regards,",
    "Trace and Tether Craft Studio Limited",
  ].join("\n");
  const raw = [
    `To: ${safeHeader(content.customerEmail, 254)}`,
    `Subject: Invoice ${invoiceNumber} for delivery ${deliveryNumber}`,
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
    wrapBase64(buildSalesDeliveryInvoicePdf(content).toString("base64")),
    `--${boundary}--`,
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

export async function sendSalesDeliveryInvoiceEmail(
  content: SalesDeliveryInvoiceEmailContent,
  gmail: GmailProxy = new ReplitConnectors(),
): Promise<{ ok: true; messageId: string } | { ok: false; error: string; ambiguous?: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  timeout.unref?.();
  try {
    const response = await gmail.proxy("google-mail", "/gmail/v1/users/me/messages/send", {
      method: "POST",
      body: { raw: buildSalesDeliveryInvoiceEmail(content) },
      signal: controller.signal,
    });
    if (response.ok) {
      let id: unknown;
      try {
        const result: unknown = await response.json();
        if (result && typeof result === "object" && "id" in result) id = (result as { id?: unknown }).id;
      } catch {
        id = null;
      }
      return typeof id === "string" && id.trim() && id.trim().length <= 255
        ? { ok: true, messageId: id.trim() }
        : { ok: false, ambiguous: true, error: "Gmail accepted the email but did not confirm it. Check Gmail Sent before retrying." };
    }
    const responseText = await response.text().catch(() => "");
    let details: string | null = null;
    try {
      details = providerMessage(JSON.parse(responseText));
    } catch {
      details = null;
    }
    const suffix = details ? `: ${details.replace(/[\r\n]+/g, " ").slice(0, 300)}` : "";
    return {
      ok: false,
      ...(response.status >= 500 ? { ambiguous: true } : {}),
      error: `Gmail could not send the invoice (HTTP ${response.status})${suffix}`,
    };
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") {
      return { ok: false, ambiguous: true, error: "Gmail did not confirm whether the email was sent. Check Gmail Sent before retrying." };
    }
    const detail = cause instanceof Error ? cause.message.replace(/[\r\n]+/g, " ").slice(0, 300) : "";
    return {
      ok: false,
      ambiguous: true,
      error: detail ? `Gmail could not send the invoice: ${detail}` : "Gmail could not send the invoice. Check the Gmail connection and try again.",
    };
  } finally {
    clearTimeout(timeout);
  }
}
