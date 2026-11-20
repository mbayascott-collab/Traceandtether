export interface DeliveryNoteStockLocation {
  locationName: string | null;
  quantity: number;
}

export function describeDeliveryNoteLocations(
  locations: readonly DeliveryNoteStockLocation[] | null | undefined,
): string {
  const recorded = (locations ?? []).filter((location) => location.quantity > 0);
  if (!recorded.length) return "Warehouse not recorded for this delivery.";

  return recorded
    .map(({ locationName, quantity }) => `${locationName?.trim() || "Unassigned location"}: ${quantity}`)
    .join(", ");
}
