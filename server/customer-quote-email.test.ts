import assert from "node:assert/strict";
import test from "node:test";
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
      return new Response("{}", { status: 200 });
    },
  });
  assert.deepEqual(accepted, { ok: true });
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
