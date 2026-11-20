import assert from "node:assert/strict";
import test from "node:test";
import { customerGroupAccessAfterPermissionLoss, emptyCustomerGroupAccess } from "./customer-group-access";

test("failed audience permission refresh clears groups, permissions, and member details", () => {
  assert.deepEqual(emptyCustomerGroupAccess(), {
    groups: [],
    canManage: false,
    canViewMembers: false,
    selectedGroupId: null,
    members: [],
  });
});

test("an owner permission downgrade after refresh clears previously loaded group data", () => {
  const ownerState = {
    groups: [{ id: 7, name: "Repeat customers" }],
    canManage: true,
    canViewMembers: true,
    selectedGroupId: 7,
    members: [{ id: 19, email: "private@example.test" }],
  };
  const refreshedPermissions = { canManage: false, canViewMembers: false };
  const cleared = customerGroupAccessAfterPermissionLoss<typeof ownerState.groups[number], typeof ownerState.members[number]>(
    refreshedPermissions,
  );
  assert.ok(cleared);
  assert.deepEqual({ ...ownerState, ...cleared }, {
    groups: [],
    canManage: false,
    canViewMembers: false,
    selectedGroupId: null,
    members: [],
  });
});
