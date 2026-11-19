export interface StockLocationAvailability {
  id: number;
  name: string;
  available: number;
}

export interface StockLocationAllocation extends StockLocationAvailability {
  quantity: number;
}

export function salesStockLocationPriority(left: StockLocationAvailability, right: StockLocationAvailability) {
  const mainPriority = Number(right.name.toLowerCase() === "main") - Number(left.name.toLowerCase() === "main");
  return mainPriority || left.name.localeCompare(right.name);
}

export function chooseSalesStockAllocations(
  locations: StockLocationAvailability[],
  quantity: number,
  requestedLocationId: number | null,
): { allocations: StockLocationAllocation[] } | { error: string } {
  if (requestedLocationId !== null) {
    const selected = locations.find((location) => location.id === requestedLocationId);
    if (!selected) return { error: "The selected stock location is no longer active. Choose another location." };
    if (selected.available < quantity) {
      return { error: `${selected.available} units available at ${selected.name}; ${quantity} requested.` };
    }
    return { allocations: [{ ...selected, quantity }] };
  }

  const singleLocation = locations
    .filter((location) => location.available >= quantity)
    .sort(salesStockLocationPriority)[0];
  if (singleLocation) return { allocations: [{ ...singleLocation, quantity }] };

  let remaining = quantity;
  const allocations: StockLocationAllocation[] = [];
  for (const location of locations.filter((item) => item.available > 0).sort(salesStockLocationPriority)) {
    const allocated = Math.min(location.available, remaining);
    if (allocated > 0) allocations.push({ ...location, quantity: allocated });
    remaining -= allocated;
    if (remaining === 0) return { allocations };
  }

  const available = locations.reduce((total, location) => total + Math.max(0, location.available), 0);
  return { error: `Only ${available} units are available across active locations; ${quantity} requested.` };
}

export function allocateReservationConsumption<T extends { id: number; locationId: number | null; quantity: number }>(
  reservations: T[],
  quantity: number,
): { reservationId: number; locationId: number | null; quantity: number }[] | null {
  let remaining = quantity;
  const consumption: { reservationId: number; locationId: number | null; quantity: number }[] = [];
  for (const reservation of [...reservations].sort((left, right) => left.id - right.id)) {
    const consumed = Math.min(Math.max(0, reservation.quantity), remaining);
    if (consumed > 0) {
      consumption.push({ reservationId: reservation.id, locationId: reservation.locationId, quantity: consumed });
      remaining -= consumed;
    }
    if (remaining === 0) return consumption;
  }
  return null;
}
