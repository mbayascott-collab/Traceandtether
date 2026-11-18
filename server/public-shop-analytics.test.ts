import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  publicShopAttemptSummary, recordPublicShopAttempt, type PublicShopAttemptSummary,
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
  assert.ok(statements.every((statement) => !/email|phone|address|ip/i.test(statement)));
  assert.deepEqual(publicShopAttemptSummary({
    acceptedCount: counts.accepted,
    blockedCount: counts.blocked,
  }), { accepted: 1, blocked: 2 });
  assert.deepEqual(publicShopAttemptSummary(), { accepted: 0, blocked: 0 });
});
