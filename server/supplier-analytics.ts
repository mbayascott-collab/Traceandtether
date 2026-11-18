export type SupplierDeliveryOrder = {
  id: number;
  supplierId: number;
  supplierName: string;
  status: string;
  expectedAt: string | null;
};

export type SupplierDeliveryShipment = {
  id: number;
  purchaseOrderId: number;
  status: string;
  expectedAt: string | null;
  receivedAt: string | null;
};

export type SupplierDeliveryLink = {
  shipmentId: number;
  purchaseOrderId: number;
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
