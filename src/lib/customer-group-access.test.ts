import assert from "node:assert/strict";
import test from "node:test";
import { emptyCustomerGroupAccess } from "./customer-group-access";

test("failed audience permission refresh clears groups, permissions, and member details", () => {
  assert.deepEqual(emptyCustomerGroupAccess(), {
    groups: [],
    canManage: false,
    canViewMembers: false,
    selectedGroupId: null,
    members: [],
  });
});
