export function emptyCustomerGroupAccess<TGroup, TMember>() {
  return {
    groups: [] as TGroup[],
    canManage: false,
    canViewMembers: false,
    selectedGroupId: null as number | null,
    members: [] as TMember[],
  };
}
