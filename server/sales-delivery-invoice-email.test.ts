import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSalesDeliveryInvoiceEmail,
  buildSalesDeliveryInvoicePdf,
  sendSalesDeliveryInvoiceEmail,
  type SalesDeliveryInvoiceEmailContent,
} from "./sales-delivery-invoice-email";

const invoice: SalesDeliveryInvoiceEmailContent = {
  invoiceNumber: "INV-2026-DELIVERY1",
  deliveryNumber: "DN-2026-DELIVERY1",
  deliveryDate: "2026-11-12",
  orderNumber: "SO-2026-ORDER1",
  customerName: "Customer",
  customerEmail: "customer@example.test",
  totalZmw: "24.68",
  lines: [{
    productName: "Handmade bag",
    sku: "BAG-1",
    quantity: 2,
    unitPriceZmw: "12.34",
    lineTotalZmw: "24.68",
  }],
};

function decodeEmail(value: string) {
  const raw = Buffer.from(value, "base64url").toString("utf8");
  const boundary = raw.match(/boundary="([^"]+)"/)?.[1];
  assert.ok(boundary);
  const parts = raw.split(`--${boundary}`).slice(1, -1).map((part) => part.replace(/^\r\n/, ""));
  const getBody = (part: string) => part.slice(part.indexOf("\r\n\r\n") + 4).replace(/\r\n/g, "");
  return {
    raw: raw.slice(0, raw.indexOf("\r\n\r\n")),
    body: Buffer.from(getBody(parts[0]!), "base64").toString("utf8"),
    pdf: Buffer.from(getBody(parts[1]!), "base64"),
    attachmentHeaders: parts[1]!.slice(0, parts[1]!.indexOf("\r\n\r\n")),
  };
}

test("delivery invoice PDF contains only the selected delivery's date, lines, prices, and total", () => {
  const pdf = buildSalesDeliveryInvoicePdf(invoice).toString("latin1");
  for (const text of [
    invoice.invoiceNumber, invoice.deliveryNumber, invoice.deliveryDate,
    "Handmade bag", "BAG-1", "Quantity: 2", "Unit price: ZMW 12.34", "TOTAL: ZMW 24.68",
  ]) assert.ok(pdf.includes(text), `Expected PDF to contain ${text}`);
});

test("delivery invoice email attaches the matching PDF and uses the saved customer address", () => {
  const { raw, body, pdf, attachmentHeaders } = decodeEmail(buildSalesDeliveryInvoiceEmail(invoice));
  assert.match(raw, /^To: customer@example\.test\r\n/);
  assert.match(raw, /Subject: Invoice INV-2026-DELIVERY1 for delivery DN-2026-DELIVERY1/);
  assert.match(body, /Delivery date: 2026-11-12/);
  assert.match(body, /Handmade bag \(BAG-1\): 2 × ZMW 12\.34 = ZMW 24\.68/);
  assert.match(body, /Total: ZMW 24\.68/);
  assert.match(attachmentHeaders, /Content-Type: application\/pdf; name="INV-2026-DELIVERY1\.pdf"/);
  assert.match(attachmentHeaders, /Content-Disposition: attachment; filename="INV-2026-DELIVERY1\.pdf"/);
  assert.deepEqual(pdf, buildSalesDeliveryInvoicePdf(invoice));
});

test("reports Gmail send success and provider failure", async () => {
  let raw: string | undefined;
  const success = await sendSalesDeliveryInvoiceEmail(invoice, {
    async proxy(connector, path, options) {
      assert.equal(connector, "google-mail");
      assert.equal(path, "/gmail/v1/users/me/messages/send");
      raw = (options?.body as { raw: string }).raw;
      return new Response(JSON.stringify({ id: "gmail-delivery-invoice-1" }), { status: 200 });
    },
  });
  assert.deepEqual(success, { ok: true, messageId: "gmail-delivery-invoice-1" });
  assert.ok(raw);
  assert.deepEqual(decodeEmail(raw).pdf, buildSalesDeliveryInvoicePdf(invoice));

  const failure = await sendSalesDeliveryInvoiceEmail(invoice, {
    async proxy() {
      return new Response(JSON.stringify({ error: { message: "Insufficient Permission" } }), { status: 403 });
    },
  });
  assert.deepEqual(failure, {
    ok: false,
    error: "Gmail could not send the invoice (HTTP 403): Insufficient Permission",
  });
});
