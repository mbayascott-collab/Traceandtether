import assert from "node:assert/strict";
import test from "node:test";
import { auditLogQuerySchema } from "./schema";

test("audit history filters default to the first 50-entry page", () => {
  assert.deepEqual(auditLogQuerySchema.parse({}), {
    page: 1,
    pageSize: 50,
  });
});

test("audit history filters validate and normalize supported query values", () => {
  assert.deepEqual(auditLogQuerySchema.parse({
    entityType: "sales_order",
    actor: " owner@example.com ",
    from: "2026-11-01",
    to: "2026-11-18",
    page: "3",
    pageSize: "25",
  }), {
    entityType: "sales_order",
    actor: "owner@example.com",
    from: "2026-11-01",
    to: "2026-11-18",
    page: 3,
    pageSize: 25,
  });
});

test("audit history filters reject invalid values and reversed dates", () => {
  const invalidQueries = [
    { entityType: "not-a-record" },
    { actor: "not-an-email" },
    { from: "2026-02-30" },
    { from: "2026-11-19", to: "2026-11-18" },
    { page: "0" },
    { page: "1000001" },
    { pageSize: "251" },
    { unexpected: "value" },
  ];

  for (const query of invalidQueries) {
    assert.equal(auditLogQuerySchema.safeParse(query).success, false, JSON.stringify(query));
  }
});
