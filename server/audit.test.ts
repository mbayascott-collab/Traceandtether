import assert from "node:assert/strict";
import test from "node:test";
import { businessAuditLogs } from "../shared/schema";
import { recordBusinessAudit } from "./audit";

test("audit records identify the actor, record, action, and changed fields", async () => {
  let inserted: Record<string, unknown> | undefined;
  await recordBusinessAudit({
    insert(table: typeof businessAuditLogs) {
      assert.equal(table, businessAuditLogs);
      return {
        values(values: Record<string, unknown>) {
          inserted = values;
          return Promise.resolve();
        },
      };
    },
  }, {
    entityType: "sales_order",
    entityId: 42,
    recordLabel: "SO-2026-ABC123",
    actor: { clerkUserId: "user_123", email: "owner@example.com" },
    action: "updated",
    changedFields: ["status", "dueDate"],
  });

  assert.deepEqual(inserted, {
    entityType: "sales_order",
    entityId: 42,
    recordLabel: "SO-2026-ABC123",
    actorClerkUserId: "user_123",
    actorEmail: "owner@example.com",
    action: "updated",
    changedFields: ["status", "dueDate"],
  });
});

test("public shop audit records support an action without a signed-in account", async () => {
  let inserted: Record<string, unknown> | undefined;
  await recordBusinessAudit({
    insert() {
      return {
        values(values: Record<string, unknown>) {
          inserted = values;
          return Promise.resolve();
        },
      };
    },
  }, {
    entityType: "customer",
    entityId: 5,
    recordLabel: "Customer",
    actor: { clerkUserId: null, email: "Public shop" },
    action: "created",
  });

  assert.equal(inserted?.actorClerkUserId, null);
  assert.equal(inserted?.actorEmail, "Public shop");
  assert.deepEqual(inserted?.changedFields, []);
});
