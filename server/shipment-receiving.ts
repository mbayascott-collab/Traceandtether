type ShipmentReceiptLine = {
  id: number;
  purchaseOrderLineId: number;
  quantityShipped: number;
  quantityStocked: number;
};

type PurchaseOrderReceiptLine = {
  id: number;
  purchaseOrderId: number;
  quantityOrdered: number;
};

type ShipmentReceiptInput = {
  shipmentLines: ShipmentReceiptLine[];
  requestedQuantities: Map<number, number>;
  purchaseOrderLines: PurchaseOrderReceiptLine[];
  otherReceivedByLine: Map<number, number>;
  purchaseOrderStatuses: Map<number, string>;
};

export function validateShipmentReceipt(input: ShipmentReceiptInput): string | null {
  const purchaseOrderIdByLine = new Map(
    input.purchaseOrderLines.map((line) => [line.id, line.purchaseOrderId]),
  );
  if (input.shipmentLines.some((line) => input.purchaseOrderStatuses.get(purchaseOrderIdByLine.get(line.purchaseOrderLineId) ?? -1) === "cancelled")) {
    return "Cancelled purchase orders cannot receive shipment quantities.";
  }

  for (const line of input.shipmentLines) {
    const quantity = input.requestedQuantities.get(line.id);
    if (quantity === undefined) return "Include a received quantity for every line in this shipment.";
    if (quantity > line.quantityShipped) return "Received quantity cannot exceed the quantity shipped.";
    if (quantity < line.quantityStocked) return "Received quantity cannot be reduced below the quantity already posted to stock.";
    const ordered = input.purchaseOrderLines.find((row) => row.id === line.purchaseOrderLineId)?.quantityOrdered ?? 0;
    const otherLinesInShipment = input.shipmentLines
      .filter((other) => other.id !== line.id && other.purchaseOrderLineId === line.purchaseOrderLineId)
      .reduce((total, other) => total + (input.requestedQuantities.get(other.id) ?? 0), 0);
    const previouslyReceived = input.otherReceivedByLine.get(line.purchaseOrderLineId) ?? 0;
    if (previouslyReceived + otherLinesInShipment + quantity > ordered) {
      return "Total received quantity cannot exceed the quantity ordered.";
    }
  }
  return null;
}

export function shipmentReceiptStatus(
  receivedLines: { quantityReceived: number }[],
  shippedLines: { quantityShipped: number }[],
): "in_transit" | "partially_received" | "received" {
  const received = receivedLines.reduce((total, line) => total + line.quantityReceived, 0);
  const shipped = shippedLines.reduce((total, line) => total + line.quantityShipped, 0);
  return received === shipped ? "received" : received > 0 ? "partially_received" : "in_transit";
}

export function purchaseOrderReceiptStatus(
  orderLines: PurchaseOrderReceiptLine[],
  receivedByLine: Map<number, number>,
): "ordered" | "partially_received" | "received" {
  const received = orderLines.reduce((total, line) => total + (receivedByLine.get(line.id) ?? 0), 0);
  const ordered = orderLines.reduce((total, line) => total + line.quantityOrdered, 0);
  return received === ordered ? "received" : received > 0 ? "partially_received" : "ordered";
}
