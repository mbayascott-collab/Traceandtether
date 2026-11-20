export type CustomerGroupAccessState<TGroup, TMember> = {
  groups: TGroup[];
  canManage: boolean;
  canViewMembers: boolean;
  selectedGroupId: number | null;
  members: TMember[];
};

export function emptyCustomerGroupAccess<TGroup, TMember>(): CustomerGroupAccessState<TGroup, TMember> {
  return {
    groups: [],
    canManage: false,
    canViewMembers: false,
    selectedGroupId: null,
    members: [],
  };
}

export function customerGroupAccessAfterPermissionLoss<TGroup, TMember>(
  permissions: { canManage: boolean; canViewMembers: boolean },
): CustomerGroupAccessState<TGroup, TMember> | null {
  return permissions.canManage && permissions.canViewMembers
    ? null
    : emptyCustomerGroupAccess<TGroup, TMember>();
}
