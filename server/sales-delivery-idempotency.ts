export type DeliveryRequestLine = { salesOrderLineId: number; quantity: number };

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
      line.quantity === requestedLines[index].quantity);
}
