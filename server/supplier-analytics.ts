import type { SupplierMonthlySpendRow } from "../shared/supplier-report-csv";

export type SupplierDeliveryOrder = {
  id: number;
  supplierId: number;
  supplierName: string;
  orderNumber?: string;
  status: string;
  expectedAt: string | null;
};

export type SupplierDeliveryShipment = {
  id: number;
  purchaseOrderId: number;
  shipmentReference?: string | null;
  status: string;
  expectedAt: string | null;
  receivedAt: string | null;
};

export type SupplierDeliveryLink = {
  shipmentId: number;
  purchaseOrderId: number;
};

export type SupplierShipmentDetail = {
  supplierId: number;
  supplierName: string;
  orderNumber: string;
  shipmentId: number;
  shipmentReference: string | null;
  status: string;
  expectedAt: string | null;
  receivedAt: string | null;
};

export type SupplierDeliveryMetrics = {
  onTimeDeliveries: number;
  lateDeliveries: number;
  measuredDeliveries: number;
  averageDeliveryVarianceDays: string | null;
  overdueOpenOrders: number;
  missingExpectedDateOrders: number;
  missingActualDateOrders: number;
  incompleteDeliveryOrders: number;
};

export type SupplierMonthlySpendInput = {
  purchaseLines: {
    supplierId: number; supplierName: string; orderedAt: string; status: string; totalZmw: string;
  }[];
  expenses: {
    incurredAt: string; amountZmw: string;
    allocations: { supplierId: number; supplierName: string; amountZmw: string }[];
  }[];
  payments: { paymentDate: string; amountZmw: string }[];
  fromDate: string | null;
  toDate: string | null;
};

const toCents = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
};
const fromCents = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;

export function supplierMonthlySpend(input: SupplierMonthlySpendInput): SupplierMonthlySpendRow[] {
  type MonthlySupplierSpend = {
    supplierId: number; supplierName: string; orderedGoods: bigint; importCosts: bigint;
  };
  type MonthlyTotals = {
    orderedGoods: bigint; importCosts: bigint; payments: bigint;
    suppliers: Map<number, MonthlySupplierSpend>;
  };
  const monthTotals = new Map<string, MonthlyTotals>();
  const getMonth = (month: string) => {
    let totals = monthTotals.get(month);
    if (!totals) {
      totals = { orderedGoods: 0n, importCosts: 0n, payments: 0n, suppliers: new Map() };
      monthTotals.set(month, totals);
    }
    return totals;
  };
  const getSupplier = (totals: MonthlyTotals, supplierId: number, supplierName: string) => {
    let supplier = totals.suppliers.get(supplierId);
    if (!supplier) {
      supplier = { supplierId, supplierName, orderedGoods: 0n, importCosts: 0n };
      totals.suppliers.set(supplierId, supplier);
    }
    return supplier;
  };
  const inRange = (date: string) => {
    if ((input.fromDate && date < input.fromDate) || (input.toDate && date > input.toDate)) return;
    return date.slice(0, 7);
  };

  for (const line of input.purchaseLines) {
    const month = line.status !== "cancelled" ? inRange(line.orderedAt) : undefined;
    if (month) {
      const totals = getMonth(month);
      totals.orderedGoods += toCents(line.totalZmw);
      getSupplier(totals, line.supplierId, line.supplierName).orderedGoods += toCents(line.totalZmw);
    }
  }
  for (const expense of input.expenses) {
    const month = inRange(expense.incurredAt);
    if (!month) continue;
    const totals = getMonth(month);
    totals.importCosts += toCents(expense.amountZmw);
    for (const allocation of expense.allocations) {
      getSupplier(totals, allocation.supplierId, allocation.supplierName).importCosts += toCents(allocation.amountZmw);
    }
  }
  for (const payment of input.payments) {
    const month = inRange(payment.paymentDate);
    if (month) getMonth(month).payments += toCents(payment.amountZmw);
  }

  const observedMonths = [...monthTotals.keys()].sort();
  const firstMonth = input.fromDate?.slice(0, 7) ?? observedMonths[0];
  const lastMonth = input.toDate?.slice(0, 7) ?? observedMonths.at(-1);
  if (!firstMonth || !lastMonth || firstMonth > lastMonth) return [];

  const result: SupplierMonthlySpendRow[] = [];
  const [startYear, startMonth] = firstMonth.split("-").map(Number);
  const [endYear, endMonth] = lastMonth.split("-").map(Number);
  for (let year = startYear, month = startMonth; year < endYear || (year === endYear && month <= endMonth);) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    const totals = monthTotals.get(key) ?? { orderedGoods: 0n, importCosts: 0n, payments: 0n, suppliers: new Map() };
    result.push({
      month: key,
      orderedGoodsZmw: fromCents(totals.orderedGoods),
      importCostsZmw: fromCents(totals.importCosts),
      paymentsZmw: fromCents(totals.payments),
      suppliers: [...totals.suppliers.values()]
        .sort((a, b) => a.supplierName.localeCompare(b.supplierName) || a.supplierId - b.supplierId)
        .map((supplier) => ({
          supplierId: supplier.supplierId,
          supplierName: supplier.supplierName,
          orderedGoodsZmw: fromCents(supplier.orderedGoods),
          importCostsZmw: fromCents(supplier.importCosts),
        })),
    });
    month += 1;
    if (month > 12) {
      year += 1;
      month = 1;
    }
  }
  return result;
}

const daysBetween = (expectedAt: string, actualAt: string) =>
  Math.round((Date.parse(`${actualAt}T00:00:00Z`) - Date.parse(`${expectedAt}T00:00:00Z`)) / 86_400_000);

export function supplierDeliveryMetrics(
  orders: SupplierDeliveryOrder[],
  shipments: SupplierDeliveryShipment[],
  links: SupplierDeliveryLink[],
  today: string,
) {
  const orderIdsByShipment = new Map<number, Set<number>>();
  for (const shipment of shipments) {
    const linked = orderIdsByShipment.get(shipment.id) ?? new Set<number>();
    linked.add(shipment.purchaseOrderId);
    orderIdsByShipment.set(shipment.id, linked);
  }
  for (const link of links) {
    const linked = orderIdsByShipment.get(link.shipmentId) ?? new Set<number>();
    linked.add(link.purchaseOrderId);
    orderIdsByShipment.set(link.shipmentId, linked);
  }
  const shipmentsByOrder = new Map<number, SupplierDeliveryShipment[]>();
  for (const [shipmentId, orderIds] of orderIdsByShipment) {
    const shipment = shipments.find((item) => item.id === shipmentId);
    if (!shipment || shipment.status === "cancelled") continue;
    for (const orderId of orderIds) {
      shipmentsByOrder.set(orderId, [...(shipmentsByOrder.get(orderId) ?? []), shipment]);
    }
  }

  const bySupplier = new Map<number, SupplierDeliveryMetrics>();
  const getMetrics = (supplierId: number): SupplierDeliveryMetrics => {
    let metrics = bySupplier.get(supplierId);
    if (!metrics) {
      metrics = {
        onTimeDeliveries: 0,
        lateDeliveries: 0,
        measuredDeliveries: 0,
        averageDeliveryVarianceDays: null,
        overdueOpenOrders: 0,
        missingExpectedDateOrders: 0,
        missingActualDateOrders: 0,
        incompleteDeliveryOrders: 0,
      };
      bySupplier.set(supplierId, metrics);
    }
    return metrics;
  };
  const varianceTotals = new Map<number, { days: number; count: number }>();

  for (const order of orders) {
    if (order.status === "cancelled") continue;
    const metrics = getMetrics(order.supplierId);
    const relatedShipments = shipmentsByOrder.get(order.id) ?? [];
    const hasExpectedDateForEveryDelivery = relatedShipments.length
      ? relatedShipments.every((shipment) => shipment.expectedAt || order.expectedAt)
      : Boolean(order.expectedAt);
    if (!hasExpectedDateForEveryDelivery) metrics.missingExpectedDateOrders += 1;

    if (order.status !== "received") {
      metrics.incompleteDeliveryOrders += 1;
      if ((order.expectedAt && order.expectedAt < today)
        || relatedShipments.some((shipment) => shipment.status !== "received" && shipment.expectedAt && shipment.expectedAt < today)) {
        metrics.overdueOpenOrders += 1;
      }
    }

    const actualShipments = relatedShipments.filter((shipment) => shipment.status === "received" && shipment.receivedAt);
    if (order.status === "received" && actualShipments.length === 0) {
      metrics.missingActualDateOrders += 1;
    }

    for (const shipment of actualShipments) {
      const expectedAt = shipment.expectedAt ?? order.expectedAt;
      if (!expectedAt) continue;
      const variance = daysBetween(expectedAt, shipment.receivedAt!);
      metrics.measuredDeliveries += 1;
      if (variance <= 0) metrics.onTimeDeliveries += 1;
      else metrics.lateDeliveries += 1;
      const total = varianceTotals.get(order.supplierId) ?? { days: 0, count: 0 };
      total.days += variance;
      total.count += 1;
      varianceTotals.set(order.supplierId, total);
    }
  }

  for (const [supplierId, total] of varianceTotals) {
    const metrics = bySupplier.get(supplierId)!;
    metrics.averageDeliveryVarianceDays = (total.days / total.count).toFixed(1);
  }

  return bySupplier;
}

export function supplierShipmentDetails(
  orders: SupplierDeliveryOrder[],
  shipments: SupplierDeliveryShipment[],
  links: SupplierDeliveryLink[],
): SupplierShipmentDetail[] {
  const activeOrders = new Map(
    orders.filter((order) => order.status !== "cancelled").map((order) => [order.id, order]),
  );
  const orderIdsByShipment = new Map<number, Set<number>>();
  for (const shipment of shipments) {
    const linked = orderIdsByShipment.get(shipment.id) ?? new Set<number>();
    linked.add(shipment.purchaseOrderId);
    orderIdsByShipment.set(shipment.id, linked);
  }
  for (const link of links) {
    const linked = orderIdsByShipment.get(link.shipmentId) ?? new Set<number>();
    linked.add(link.purchaseOrderId);
    orderIdsByShipment.set(link.shipmentId, linked);
  }

  return shipments.flatMap((shipment) => {
    if (shipment.status === "cancelled") return [];
    return [...(orderIdsByShipment.get(shipment.id) ?? [])]
      .flatMap((orderId) => {
        const order = activeOrders.get(orderId);
        if (!order) return [];
        return [{
          supplierId: order.supplierId,
          supplierName: order.supplierName,
          orderNumber: order.orderNumber ?? String(order.id),
          shipmentId: shipment.id,
          shipmentReference: shipment.shipmentReference ?? null,
          status: shipment.status,
          expectedAt: shipment.expectedAt,
          receivedAt: shipment.receivedAt,
        }];
      });
  }).sort((a, b) =>
    a.supplierName.localeCompare(b.supplierName)
      || a.orderNumber.localeCompare(b.orderNumber)
      || a.shipmentId - b.shipmentId,
  );
}
