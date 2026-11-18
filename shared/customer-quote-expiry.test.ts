import assert from "node:assert/strict";
import test from "node:test";
import { isCustomerQuoteExpired, requiresCustomerQuoteExpiryConfirmation } from "./customer-quote-expiry";

test("customer quote expiry follows the Zambia calendar date", () => {
  const justBeforeZambiaMidnight = new Date("2026-11-17T21:59:59.999Z");
  const atZambiaMidnight = new Date("2026-11-17T22:00:00.000Z");

  assert.equal(isCustomerQuoteExpired("2026-11-17", justBeforeZambiaMidnight), false);
  assert.equal(isCustomerQuoteExpired("2026-11-17", atZambiaMidnight), true);
  assert.equal(isCustomerQuoteExpired("2026-11-18", atZambiaMidnight), false);
  assert.equal(isCustomerQuoteExpired(null, atZambiaMidnight), false);
});

test("only an explicit confirmation permits conversion of an expired quote", () => {
  const now = new Date("2026-11-18T10:00:00.000Z");

  assert.equal(requiresCustomerQuoteExpiryConfirmation("2026-11-17", undefined, now), true);
  assert.equal(requiresCustomerQuoteExpiryConfirmation("2026-11-17", false, now), true);
  assert.equal(requiresCustomerQuoteExpiryConfirmation("2026-11-17", true, now), false);
  assert.equal(requiresCustomerQuoteExpiryConfirmation("2026-11-18", false, now), false);
});
