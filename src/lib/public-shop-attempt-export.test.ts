import assert from "node:assert/strict";
import test from "node:test";
import { publicShopAttemptDaysCsv, type PublicShopAttemptDay } from "./api";

test("public shop daily CSV includes zero-activity dates and only aggregate columns", () => {
  const days: PublicShopAttemptDay[] = [
    { day: "2026-11-17", accepted: 2, blocked: 1, rateLimited: 1, botCheck: 0, unclassifiedBlocked: 0 },
    { day: "2026-11-18", accepted: 0, blocked: 0, rateLimited: 0, botCheck: 0, unclassifiedBlocked: 0 },
  ];

  assert.equal(
    publicShopAttemptDaysCsv(days),
    '"Date (UTC)","Accepted","Blocked"\r\n"2026-11-17","2","1"\r\n"2026-11-18","0","0"',
  );
  assert.doesNotMatch(publicShopAttemptDaysCsv(days), /visitor|email|ip address/i);
});
