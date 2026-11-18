import assert from "node:assert/strict";
import test from "node:test";
import { buildPaymentReminderEmail, sendPaymentReminderEmail, type PaymentReminderEmailContent } from "./payment-reminder-email";

const reminder: PaymentReminderEmailContent = {
  orderNumber: "SO-2026-001",
  customerName: "A Customer",
  customerEmail: "customer@example.test",
  outstandingZmw: "1250.50",
  dueDate: "2026-10-31",
  note: "Please contact us if you need a copy of the invoice.",
};

function decodeRaw(value: string) {
  const raw = Buffer.from(value, "base64url").toString("utf8");
  const separator = raw.indexOf("\r\n\r\n");
  assert.notEqual(separator, -1);
  const encodedBody = raw.slice(separator + 4).replace(/\r\n/g, "");
  return { raw: raw.slice(0, separator), body: Buffer.from(encodedBody, "base64").toString("utf8") };
}

test("builds a reminder with the customer, order, overdue amount and due date", () => {
  const { raw, body } = decodeRaw(buildPaymentReminderEmail(reminder));
  assert.match(raw, /^To: customer@example\.test\r\n/);
  assert.match(raw, /Subject: Payment reminder for order SO-2026-001/);
  assert.match(body, /Dear A Customer,/);
  assert.match(body, /order SO-2026-001/);
  assert.match(body, /Amount still owed: ZMW 1,250\.50/);
  assert.match(body, /Due date: 2026-10-31/);
  assert.match(body, /Please contact us if you need a copy of the invoice\./);
});

test("removes line breaks from message headers", () => {
  const { raw } = decodeRaw(buildPaymentReminderEmail({
    ...reminder, orderNumber: "SO-1\r\nBcc: hidden@example.test",
  }));
  assert.doesNotMatch(raw, /\r\nBcc:/);
  assert.match(raw, /Subject: Payment reminder for order SO-1 Bcc: hidden@example\.test/);
});

test("sends with Gmail and reports delivery-provider errors", async () => {
  let requestBody: unknown;
  const accepted = await sendPaymentReminderEmail(reminder, {
    async proxy(connector, path, options) {
      assert.equal(connector, "google-mail");
      assert.equal(path, "/gmail/v1/users/me/messages/send");
      requestBody = options?.body;
      return new Response(JSON.stringify({ id: "gmail-message-1" }), { status: 200 });
    },
  });
  assert.deepEqual(accepted, { ok: true, messageId: "gmail-message-1" });
  assert.equal(typeof requestBody === "object" && requestBody !== null && "raw" in requestBody, true);

  const rejected = await sendPaymentReminderEmail(reminder, {
    async proxy() {
      return new Response(JSON.stringify({ error: { message: "Insufficient Permission" } }), { status: 403 });
    },
  });
  assert.deepEqual(rejected, {
    ok: false,
    error: "Gmail could not send the reminder (HTTP 403): Insufficient Permission",
  });
});
