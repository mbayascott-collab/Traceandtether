import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  completePublicShopAttemptDays, isPublicShopAttemptDateRange, publicShopAttemptSummary, recordPublicShopAttempt,
  type PublicShopAttemptDay, type PublicShopAttemptSummary,
} from "./public-shop-analytics";

test("records accepted and blocked shop requests as aggregate-only counters", async () => {
  const dialect = new PgDialect();
  const counts: PublicShopAttemptSummary = { accepted: 0, blocked: 0 };
  const statements: string[] = [];
  const executor = {
    async execute(query: Parameters<typeof dialect.sqlToQuery>[0]) {
      const statement = dialect.sqlToQuery(query);
      statements.push(statement.sql);
      counts.accepted += Number(statement.params[0]);
      counts.blocked += Number(statement.params[1]);
      return {};
    },
  };

  await recordPublicShopAttempt(executor, "accepted");
  await recordPublicShopAttempt(executor, "blocked");
  await recordPublicShopAttempt(executor, "blocked");

  assert.deepEqual(counts, { accepted: 1, blocked: 2 });
  assert.equal(statements.length, 3);
  assert.ok(statements.every((statement) => /ON CONFLICT \(id\) DO UPDATE/.test(statement)));
  assert.ok(statements.every((statement) => /ON CONFLICT \(day\) DO UPDATE/.test(statement)));
  assert.ok(statements.every((statement) => /statement_timestamp\(\) AT TIME ZONE 'UTC'/.test(statement)));
  assert.ok(statements.every((statement) => !/email|phone|address|ip_hash/i.test(statement)));
  assert.deepEqual(publicShopAttemptSummary({
    acceptedCount: counts.accepted,
    blockedCount: counts.blocked,
  }), { accepted: 1, blocked: 2 });
  assert.deepEqual(publicShopAttemptSummary(), { accepted: 0, blocked: 0 });
});

test("daily request activity includes both date boundaries and fills empty days", () => {
  const rows: PublicShopAttemptDay[] = [
    { day: "2026-11-30", accepted: 2, blocked: 1 },
    { day: "2026-12-02", accepted: 0, blocked: 3 },
  ];
  assert.deepEqual(completePublicShopAttemptDays("2026-11-30", "2026-12-02", rows), [
    { day: "2026-11-30", accepted: 2, blocked: 1 },
    { day: "2026-12-01", accepted: 0, blocked: 0 },
    { day: "2026-12-02", accepted: 0, blocked: 3 },
  ]);
});

test("daily request activity returns zero-count dates for an empty period", () => {
  assert.deepEqual(completePublicShopAttemptDays("2026-02-28", "2026-03-01", []), [
    { day: "2026-02-28", accepted: 0, blocked: 0 },
    { day: "2026-03-01", accepted: 0, blocked: 0 },
  ]);
});

test("public shop activity date ranges reject invalid dates and reversed boundaries", () => {
  assert.equal(isPublicShopAttemptDateRange("2026-02-28", "2026-03-01"), true);
  assert.equal(isPublicShopAttemptDateRange("2026-02-30", "2026-03-01"), false);
  assert.equal(isPublicShopAttemptDateRange("2026-03-01", "2026-02-28"), false);
});
