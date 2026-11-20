export type InventoryMovementHistoryFilter = {
  productId?: number;
  fromDate?: string;
  toDate?: string;
};

export function inventoryMovementBusinessDate(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lusaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function filterInventoryMovements<T extends { productId: number; createdAt: string }>(
  movements: T[],
  filter: InventoryMovementHistoryFilter,
): T[] {
  return movements.filter((movement) => {
    if (filter.productId !== undefined && movement.productId !== filter.productId) return false;
    const day = inventoryMovementBusinessDate(movement.createdAt);
    if (filter.fromDate && day < filter.fromDate) return false;
    if (filter.toDate && day > filter.toDate) return false;
    return true;
  });
}
