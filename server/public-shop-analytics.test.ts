import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  completePublicShopAttemptDays, findPublicShopBlockedSpikes, isPublicShopAttemptDateRange, publicShopAttemptSummary, recordPublicShopAttempt,
  type PublicShopAttemptDay, type PublicShopAttemptSummary,
} from "./public-shop-analytics";

test("records accepted and blocked shop requests as aggregate-only counters", async () => {
  const dialect = new PgDialect();
  const counts: PublicShopAttemptSummary = {
    accepted: 0, blocked: 0, rateLimited: 0, botCheck: 0, unclassifiedBlocked: 0,
  };
  const statements: string[] = [];
  const executor = {
    async execute(query: Parameters<typeof dialect.sqlToQuery>[0]) {
      const statement = dialect.sqlToQuery(query);
      statements.push(statement.sql);
      counts.accepted += Number(statement.params[0]);
      counts.blocked += Number(statement.params[1]);
      counts.rateLimited += Number(statement.params[2]);
      counts.botCheck += Number(statement.params[3]);
      return {};
    },
  };

  await recordPublicShopAttempt(executor, "accepted");
  await recordPublicShopAttempt(executor, "rate_limited");
  await recordPublicShopAttempt(executor, "bot_check");

  assert.deepEqual(counts, {
    accepted: 1, blocked: 2, rateLimited: 1, botCheck: 1, unclassifiedBlocked: 0,
  });
  assert.equal(statements.length, 3);
  assert.ok(statements.every((statement) => /ON CONFLICT \(id\) DO UPDATE/.test(statement)));
  assert.ok(statements.every((statement) => /ON CONFLICT \(day\) DO UPDATE/.test(statement)));
  assert.ok(statements.every((statement) => /statement_timestamp\(\) AT TIME ZONE 'UTC'/.test(statement)));
  assert.ok(statements.every((statement) => !/email|phone|address|ip_hash/i.test(statement)));
  assert.deepEqual(publicShopAttemptSummary({
    acceptedCount: counts.accepted,
    blockedCount: counts.blocked,
    rateLimitedCount: counts.rateLimited,
    botCheckCount: counts.botCheck,
  }), {
    accepted: 1, blocked: 2, rateLimited: 1, botCheck: 1, unclassifiedBlocked: 0,
  });
  assert.deepEqual(publicShopAttemptSummary(), {
    accepted: 0, blocked: 0, rateLimited: 0, botCheck: 0, unclassifiedBlocked: 0,
  });
  assert.deepEqual(publicShopAttemptSummary({
    acceptedCount: 4, blockedCount: 7, rateLimitedCount: 2, botCheckCount: 3,
  }), {
    accepted: 4, blocked: 7, rateLimited: 2, botCheck: 3, unclassifiedBlocked: 2,
  });
  assert.ok(statements.every((statement) => /rate_limited_count/.test(statement)));
  assert.ok(statements.every((statement) => /bot_check_count/.test(statement)));
});

test("daily request activity includes both date boundaries and fills empty days", () => {
  const rows: Array<Pick<PublicShopAttemptDay, "day" | "accepted" | "blocked" | "rateLimited" | "botCheck">> = [
    { day: "2026-11-30", accepted: 2, blocked: 1, rateLimited: 1, botCheck: 0 },
    { day: "2026-12-02", accepted: 0, blocked: 3, rateLimited: 1, botCheck: 1 },
  ];
  assert.deepEqual(completePublicShopAttemptDays("2026-11-30", "2026-12-02", rows), [
    { day: "2026-11-30", accepted: 2, blocked: 1, rateLimited: 1, botCheck: 0, unclassifiedBlocked: 0 },
    { day: "2026-12-01", accepted: 0, blocked: 0, rateLimited: 0, botCheck: 0, unclassifiedBlocked: 0 },
    { day: "2026-12-02", accepted: 0, blocked: 3, rateLimited: 1, botCheck: 1, unclassifiedBlocked: 1 },
  ]);
});

test("daily request activity returns zero-count dates for an empty period", () => {
  assert.deepEqual(completePublicShopAttemptDays("2026-02-28", "2026-03-01", []), [
    { day: "2026-02-28", accepted: 0, blocked: 0, rateLimited: 0, botCheck: 0, unclassifiedBlocked: 0 },
    { day: "2026-03-01", accepted: 0, blocked: 0, rateLimited: 0, botCheck: 0, unclassifiedBlocked: 0 },
  ]);
});

test("blocked request warnings use only daily aggregate counts above the documented threshold", () => {
  const days: PublicShopAttemptDay[] = [
    { day: "2026-11-18", accepted: 1, blocked: 25, rateLimited: 25, botCheck: 0, unclassifiedBlocked: 0 },
    { day: "2026-11-19", accepted: 0, blocked: 26, rateLimited: 20, botCheck: 6, unclassifiedBlocked: 0 },
    { day: "2026-11-20", accepted: 0, blocked: 4, rateLimited: 1, botCheck: 3, unclassifiedBlocked: 0 },
  ];
  assert.deepEqual(findPublicShopBlockedSpikes(days), [{ day: "2026-11-19", blocked: 26 }]);
});

test("public shop activity date ranges reject invalid dates and reversed boundaries", () => {
  assert.equal(isPublicShopAttemptDateRange("2026-02-28", "2026-03-01"), true);
  assert.equal(isPublicShopAttemptDateRange("2026-02-30", "2026-03-01"), false);
  assert.equal(isPublicShopAttemptDateRange("2026-03-01", "2026-02-28"), false);
});
