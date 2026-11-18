export interface StockLocationAvailability {
  id: number;
  name: string;
  available: number;
}

export function chooseSalesStockLocation(
  locations: StockLocationAvailability[],
  quantity: number,
  requestedLocationId: number | null,
): { location: StockLocationAvailability } | { error: string } {
  if (requestedLocationId !== null) {
    const selected = locations.find((location) => location.id === requestedLocationId);
    if (!selected) return { error: "The selected stock location is no longer active. Choose another location." };
    if (selected.available < quantity) {
      return { error: `${selected.available} units available at ${selected.name}; ${quantity} requested.` };
    }
    return { location: selected };
  }

  const eligible = locations
    .filter((location) => location.available >= quantity)
    .sort((left, right) => {
      const mainPriority = Number(right.name.toLowerCase() === "main") - Number(left.name.toLowerCase() === "main");
      return mainPriority || left.name.localeCompare(right.name);
    });
  if (eligible.length) return { location: eligible[0] };
  const available = locations.reduce((maximum, location) => Math.max(maximum, location.available), 0);
  return { error: `No single stock location has enough available. Up to ${available} units available; ${quantity} requested.` };
}
