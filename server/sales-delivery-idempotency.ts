export type DeliveryRequestLine = {
  salesOrderLineId: number;
  quantity: number;
  locationAllocations?: { locationId: number; quantity: number }[];
};

export function matchesDeliveryRequest(
  existing: {
    salesOrderId: number;
    deliveryDate: string;
    lines: DeliveryRequestLine[];
  },
  requested: {
    salesOrderId: number;
    deliveryDate: string;
    lines: DeliveryRequestLine[];
  },
) {
  if (existing.salesOrderId !== requested.salesOrderId || existing.deliveryDate !== requested.deliveryDate) return false;
  const savedLines = [...existing.lines].sort((a, b) => a.salesOrderLineId - b.salesOrderLineId);
  const requestedLines = [...requested.lines].sort((a, b) => a.salesOrderLineId - b.salesOrderLineId);
  return savedLines.length === requestedLines.length &&
    savedLines.every((line, index) =>
      line.salesOrderLineId === requestedLines[index].salesOrderLineId &&
      line.quantity === requestedLines[index].quantity &&
      (!requestedLines[index].locationAllocations?.length ||
        sameLocationAllocations(line.locationAllocations ?? [], requestedLines[index].locationAllocations ?? [])));
}

function sameLocationAllocations(
  left: { locationId: number; quantity: number }[],
  right: { locationId: number; quantity: number }[],
) {
  const sortedLeft = [...left].sort((a, b) => a.locationId - b.locationId);
  const sortedRight = [...right].sort((a, b) => a.locationId - b.locationId);
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((allocation, index) =>
      allocation.locationId === sortedRight[index].locationId &&
      allocation.quantity === sortedRight[index].quantity);
}
