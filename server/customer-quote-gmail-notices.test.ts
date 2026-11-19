import assert from "node:assert/strict";
import test from "node:test";
import { parseGmailQuoteBounce } from "./customer-quote-gmail-notices";

const dsnPart = (text: string) => Buffer.from(text, "utf8").toString("base64url");

test("extracts a permanent Gmail bounce and the exact quote send attempt", () => {
  const attemptedAt = "2026-11-19T09:30:00.123Z";
  const message = {
    id: "gmail-bounce-id",
    internalDate: "1795080900123",
    payload: {
      mimeType: "multipart/report",
      headers: [{ name: "Subject", value: "Delivery Status Notification (Failure)" }],
      parts: [
        {
          mimeType: "text/plain",
          body: { data: dsnPart("Delivery failed.") },
        },
        {
          mimeType: "message/delivery-status",
          body: {
            data: dsnPart([
              "Final-Recipient: rfc822; customer@example.test",
              "Action: failed",
              "Status: 5.1.1",
              "Diagnostic-Code: smtp; 550 mailbox unavailable",
            ].join("\n")),
          },
        },
        {
          mimeType: "text/rfc822-headers",
          body: {
            data: dsnPart([
              "X-Trace-Tether-Quote-Number: CQ-2026-ABC123",
              `X-Trace-Tether-Email-Attempt: ${attemptedAt}`,
            ].join("\n")),
          },
        },
      ],
    },
  };

  assert.deepEqual(parseGmailQuoteBounce(message), {
    quoteNumber: "CQ-2026-ABC123",
    attemptedAt: new Date(attemptedAt),
    error: "smtp; 550 mailbox unavailable",
  });
});

test("ignores temporary delivery delays and messages without quote correlation headers", () => {
  const temporary = {
    payload: {
      mimeType: "multipart/report",
      parts: [{
        mimeType: "message/delivery-status",
        body: { data: dsnPart("Action: delayed\nStatus: 4.2.0") },
      }],
    },
  };
  const unlinked = {
    payload: {
      mimeType: "multipart/report",
      parts: [{
        mimeType: "message/delivery-status",
        body: { data: dsnPart("Action: failed\nStatus: 5.1.1") },
      }],
    },
  };

  assert.equal(parseGmailQuoteBounce(temporary), null);
  assert.equal(parseGmailQuoteBounce(unlinked), null);
});

