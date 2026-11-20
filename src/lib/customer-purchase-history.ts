import type { SalesDelivery, SalesOrder } from "./api";

type SearchableSalesOrder = Pick<SalesOrder, "orderNumber" | "orderDate" | "fulfilledAt" | "status"> & {
  deliveries: Pick<SalesDelivery, "deliveryNumber" | "deliveryDate">[];
};

export function matchesCustomerPurchaseHistory(order: SearchableSalesOrder, query: string) {
  const value = query.trim().toLowerCase();
  if (!value) return true;

  const dates = [
    order.orderDate,
    ...order.deliveries.map((delivery) => delivery.deliveryDate),
    ...(order.fulfilledAt ? [order.fulfilledAt] : []),
  ];
  const searchableDates = dates.flatMap((date) => [
    date.slice(0, 10),
    new Date(date).toLocaleDateString("en-ZM"),
  ]);
  const deliveryNumbers = order.deliveries.map((delivery) => delivery.deliveryNumber);
  if (!order.deliveries.length && order.status === "fulfilled") {
    deliveryNumbers.push(`DN-${order.orderNumber.replace(/^SO-/, "")}`);
  }

  return [order.orderNumber, ...deliveryNumbers, ...searchableDates]
    .some((item) => item.toLowerCase().includes(value));
}

export function filterCustomerPurchaseHistory<T extends SearchableSalesOrder>(orders: readonly T[], query: string): T[] {
  return orders.filter((order) => matchesCustomerPurchaseHistory(order, query));
}
