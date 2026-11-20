type ReceiptClearingCsvOrder = {
  orderNumber: string;
  supplierName: string;
  lines: Array<{ id: number; sku: string }>;
  adjustmentPreview: {
    allocatedExpensesZmw: string;
    receiptClearedTotalZmw: string;
    priorAdjustmentsClearedZmw: string;
    clearingBalanceZmw: string;
    adjustmentAvailableZmw: string;
    unpostedClearingZmw: string;
    receipts: Array<{
      journalEntryId: number;
      entryNumber: string;
      memo: string;
      entryDate: string;
      shipmentReference: string | null;
      productName: string;
      sku: string;
      quantity: number;
      clearedAmountZmw: string;
    }>;
    lines: Array<{
      lineId: number;
      productName: string;
      stockedQuantity: number;
      onHand: number;
      averageUnitCostZmw: string;
      adjustmentZmw: string;
      inventoryZmw: string;
      cogsZmw: string;
    }>;
  } | null;
};

function safeCsvCell(value: unknown) {
  const text = String(value ?? "");
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function landedCostReceiptClearingCsv(order: ReceiptClearingCsvOrder): string {
  const preview = order.adjustmentPreview;
  if (!preview) throw new Error("Landed-cost reconciliation details are unavailable.");
  const headers = [
    "Record type", "Purchase order", "Supplier", "Receipt journal ID", "Receipt journal", "Journal memo",
    "Date", "Shipment", "Product", "SKU", "Quantity received", "Receipt cleared (ZMW)",
    "Allocated expenses (ZMW)", "Total cleared by receipts (ZMW)", "Earlier adjustments cleared (ZMW)",
    "Clearing balance (ZMW)", "Ready for posted stock (ZMW)", "Awaiting stock posting (ZMW)",
    "Posted quantity", "On hand", "Weighted-average unit value (ZMW)", "Correction (ZMW)",
    "Inventory (ZMW)", "Cost of goods sold (ZMW)",
  ];
  const rows: unknown[][] = [
    headers,
    ["Reconciliation total", order.orderNumber, order.supplierName, "", "", "", "", "", "", "", "",
      "", preview.allocatedExpensesZmw, preview.receiptClearedTotalZmw, preview.priorAdjustmentsClearedZmw,
      preview.clearingBalanceZmw, preview.adjustmentAvailableZmw, preview.unpostedClearingZmw, "", "", "", "", "", ""],
    ...preview.receipts.map((receipt) => [
      "Receipt clearing", order.orderNumber, order.supplierName, receipt.journalEntryId, receipt.entryNumber,
      receipt.memo, receipt.entryDate, receipt.shipmentReference ?? "", receipt.productName, receipt.sku,
      receipt.quantity, receipt.clearedAmountZmw, "", "", "", "", "", "", "", "", "", "", "", "",
    ]),
    ...preview.lines.map((line) => [
      "Product correction", order.orderNumber, order.supplierName, "", "", "", "", "", line.productName,
      order.lines.find((orderLine) => orderLine.id === line.lineId)?.sku ?? "",
      "", "", "", "", "", "", "", "", line.stockedQuantity, line.onHand,
      line.averageUnitCostZmw, line.adjustmentZmw, line.inventoryZmw, line.cogsZmw,
    ]),
  ];
  return rows.map((row) => row.map(safeCsvCell).join(",")).join("\r\n");
}
