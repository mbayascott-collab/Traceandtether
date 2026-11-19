export type SupplierReportRow = {
  name: string;
  orders: number;
  orderedGoodsZmw: string;
  importCostsZmw: string;
  paymentsZmw: string;
  measuredDeliveryOrders: number;
  onTimeOrders: number;
  lateOrders: number;
  missingExpectedDateOrders: number;
  missingActualDateOrders: number;
  incompleteDeliveryOrders: number;
  overdueOpenOrders: number;
  averageDeliveryVarianceDays: string | null;
};

export type SupplierMonthlySpendRow = {
  month: string;
  orderedGoodsZmw: string;
  importCostsZmw: string;
  paymentsZmw: string;
  suppliers: {
    supplierId: number;
    supplierName: string;
    orderedGoodsZmw: string;
    importCostsZmw: string;
  }[];
};

export type SupplierShipmentDetailRow = {
  supplierId: number;
  supplierName: string;
  orderNumber: string;
  shipmentId: number;
  shipmentReference: string | null;
  status: string;
  expectedAt: string | null;
  receivedAt: string | null;
};

export type SupplierReportCsvData = {
  period: { from: string | null; to: string | null };
  monthlySpend: SupplierMonthlySpendRow[];
  shipments: SupplierShipmentDetailRow[];
  totals: {
    orderedGoodsZmw: string;
    importCostsZmw: string;
    unallocatedImportCostsZmw: string;
    paymentsZmw: string;
    orders: number;
    onTimeOrders: number;
    lateOrders: number;
    overdueOpenOrders: number;
    missingExpectedDateOrders: number;
    missingActualDateOrders: number;
    incompleteDeliveryOrders: number;
    measuredDeliveryOrders: number;
  };
  suppliers: SupplierReportRow[];
};

export function formatSupplierDeliveryVariance(value: string | null) {
  if (value == null) return "—";
  const days = Number(value);
  if (!Number.isFinite(days)) return "—";
  if (days === 0) return "0 days · on time";
  const amount = Math.abs(days).toLocaleString("en", { maximumFractionDigits: 1 });
  return days > 0 ? `+${amount} days · late` : `−${amount} days · early`;
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  const safe = /^[\s]*[=+@]/.test(text) || /^\s*-\D/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function supplierReportCsv(report: SupplierReportCsvData) {
  const columns = [
    "Supplier",
    "Orders",
    "Goods ordered (ZMW)",
    "Import costs (ZMW)",
    "Payments (ZMW)",
    "Matched dates",
    "On time",
    "Late",
    "Missing expected",
    "Missing actual",
    "Incomplete / open",
    "Overdue open",
    "Average variance",
  ];
  const rows: unknown[][] = [
    ["Supplier spend and delivery report"],
    ["From", report.period.from ?? "All dates"],
    ["To", report.period.to ?? "All dates"],
    [],
    columns,
    ...report.suppliers.map((supplier) => [
      supplier.name,
      supplier.orders,
      supplier.orderedGoodsZmw,
      supplier.importCostsZmw,
      supplier.paymentsZmw,
      supplier.measuredDeliveryOrders,
      supplier.onTimeOrders,
      supplier.lateOrders,
      supplier.missingExpectedDateOrders,
      supplier.missingActualDateOrders,
      supplier.incompleteDeliveryOrders,
      supplier.overdueOpenOrders,
      formatSupplierDeliveryVariance(supplier.averageDeliveryVarianceDays),
    ]),
    [
      "Total",
      report.totals.orders,
      report.totals.orderedGoodsZmw,
      report.totals.importCostsZmw,
      report.totals.paymentsZmw,
      report.totals.measuredDeliveryOrders,
      report.totals.onTimeOrders,
      report.totals.lateOrders,
      report.totals.missingExpectedDateOrders,
      report.totals.missingActualDateOrders,
      report.totals.incompleteDeliveryOrders,
      report.totals.overdueOpenOrders,
      "",
    ],
    [],
    ["Unallocated import costs (not assigned to a supplier)", report.totals.unallocatedImportCostsZmw, "ZMW"],
    [],
    ["Monthly supplier spend by recorded dates"],
    ["Goods ordered use purchase-order dates; import costs use expense dates; supplier payments use payment dates and are separate from costs."],
    ["Month", "Goods ordered (purchase-order date, ZMW)", "Import costs (expense date, ZMW)", "Supplier payments (payment date, separate, ZMW)"],
    ...report.monthlySpend.map((month) => [
      month.month, month.orderedGoodsZmw, month.importCostsZmw, month.paymentsZmw,
    ]),
    [
      "Total",
      report.monthlySpend.reduce((total, month) => total + Number(month.orderedGoodsZmw), 0).toFixed(2),
      report.monthlySpend.reduce((total, month) => total + Number(month.importCostsZmw), 0).toFixed(2),
      report.monthlySpend.reduce((total, month) => total + Number(month.paymentsZmw), 0).toFixed(2),
    ],
    [],
    ["Monthly costs by supplier"],
    ["Shared shipment expenses are allocated across linked supplier orders once; unassigned costs are excluded from supplier rows."],
    ["Month", "Supplier", "Goods ordered (ZMW)", "Allocated import costs (ZMW)"],
    ...report.monthlySpend.flatMap((month) => month.suppliers.length
      ? [
        ...month.suppliers.map((supplier) => [
          month.month, supplier.supplierName, supplier.orderedGoodsZmw, supplier.importCostsZmw,
        ]),
        [
          month.month,
          "Supplier-allocated total",
          month.suppliers.reduce((total, supplier) => total + Number(supplier.orderedGoodsZmw), 0).toFixed(2),
          month.suppliers.reduce((total, supplier) => total + Number(supplier.importCostsZmw), 0).toFixed(2),
        ],
      ]
      : [[month.month, "No supplier costs assigned this month", "0.00", "0.00"]]),
    [],
    ["Supplier shipment receipt dates"],
    ["Dates below are recorded on the shipment; blank dates are not inferred from purchase orders."],
    ["Supplier", "Purchase order", "Shipment ID", "Shipment reference", "Status", "Expected receipt date", "Actual receipt date"],
    ...report.shipments.map((shipment) => [
      shipment.supplierName,
      shipment.orderNumber,
      shipment.shipmentId,
      shipment.shipmentReference,
      shipment.status,
      shipment.expectedAt,
      shipment.receivedAt,
    ]),
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
