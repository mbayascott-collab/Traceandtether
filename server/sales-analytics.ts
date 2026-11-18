type SalesOrder = {
  id: number;
  status: string;
  orderDate: string;
  customerId: number;
  customerName: string;
};

type SalesOrderLine = {
  salesOrderId: number;
  productId: number;
  quantity: number;
  unitPriceZmw: string;
};

type SalesDeliveryLine = {
  orderId: number;
  deliveryDate: string;
  customerId: number;
  customerName: string;
  productId: number;
  quantity: number;
  price: string;
  orderStatus: string;
};

type SalesActivityInput = {
  fromDate?: string;
  toDate?: string;
  orders: SalesOrder[];
  lines: SalesOrderLine[];
  deliveries: SalesDeliveryLine[];
};

const toCents = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
};

export function calculateSalesActivity({ fromDate = "", toDate = "", orders, lines, deliveries }: SalesActivityInput) {
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const ordersWithDeliveries = new Set(deliveries.map((delivery) => delivery.orderId));
  const productActivity = new Map<number, { revenue: bigint; units: number }>();
  const monthlySales = new Map<string, bigint>();
  const customerActivity = new Map<number, { name: string; revenue: bigint; orderIds: Set<number> }>();
  const periodOrderIds = new Set<number>();
  let totalUnits = 0;

  const recordSale = (orderId: number, customerId: number, customerName: string, productId: number, quantity: number, price: string, date: string) => {
    const amount = toCents(price) * BigInt(quantity);
    const product = productActivity.get(productId) ?? { revenue: 0n, units: 0 };
    product.revenue += amount;
    product.units += quantity;
    productActivity.set(productId, product);

    const month = date.slice(0, 7);
    monthlySales.set(month, (monthlySales.get(month) ?? 0n) + amount);
    periodOrderIds.add(orderId);
    totalUnits += quantity;

    const customer = customerActivity.get(customerId) ?? { name: customerName, revenue: 0n, orderIds: new Set<number>() };
    customer.revenue += amount;
    customer.orderIds.add(orderId);
    customerActivity.set(customerId, customer);
  };

  for (const delivery of deliveries) {
    if (delivery.orderStatus === "cancelled" || (fromDate && delivery.deliveryDate < fromDate) || (toDate && delivery.deliveryDate > toDate)) continue;
    recordSale(delivery.orderId, delivery.customerId, delivery.customerName, delivery.productId, delivery.quantity, delivery.price, delivery.deliveryDate);
  }

  for (const line of lines) {
    const order = orderById.get(line.salesOrderId);
    if (!order || order.status !== "fulfilled" || ordersWithDeliveries.has(order.id) ||
      (fromDate && order.orderDate < fromDate) || (toDate && order.orderDate > toDate)) continue;
    recordSale(order.id, order.customerId, order.customerName, line.productId, line.quantity, line.unitPriceZmw, order.orderDate);
  }

  const products = [...productActivity.entries()].map(([productId, activity]) => ({ productId, ...activity }))
    .sort((a, b) => a.revenue === b.revenue ? 0 : a.revenue > b.revenue ? -1 : 1);
  const customers = [...customerActivity.entries()].map(([customerId, activity]) => ({
    customerId, name: activity.name, revenue: activity.revenue, orders: activity.orderIds.size,
  })).sort((a, b) => a.revenue === b.revenue ? 0 : a.revenue > b.revenue ? -1 : 1);

  const firstMonth = fromDate ? fromDate.slice(0, 7) : [...monthlySales.keys()].sort()[0];
  const lastMonth = toDate ? toDate.slice(0, 7) : [...monthlySales.keys()].sort().at(-1);
  const salesByMonth: { month: string; revenue: bigint }[] = [];
  if (firstMonth && lastMonth) {
    const cursor = new Date(`${firstMonth}-01T00:00:00Z`);
    const end = new Date(`${lastMonth}-01T00:00:00Z`);
    while (cursor <= end) {
      const month = cursor.toISOString().slice(0, 7);
      salesByMonth.push({ month, revenue: monthlySales.get(month) ?? 0n });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  return {
    products,
    customers,
    salesByMonth,
    totalRevenue: products.reduce((total, product) => total + product.revenue, 0n),
    summary: {
      customersWithSales: customers.length,
      repeatCustomers: customers.filter((customer) => customer.orders > 1).length,
      fulfilledOrders: periodOrderIds.size,
      unitsDelivered: totalUnits,
    },
  };
}
