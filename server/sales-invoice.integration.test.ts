import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test from "node:test";
import { customers, products, salesDeliveries, salesDeliveryLines, salesOrderLines, salesOrders } from "../shared/schema";

function toCents(amount: string): bigint {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}

test("sales orders return delivery-specific invoice lines and exact cent totals", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db, pool }, { registerSalesRoutes }] = await Promise.all([
    import("./db"),
    import("./sales-routes"),
  ]);

  const suffix = randomUUID();
  const app = express();
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `sales-invoice-${suffix}`, email: `sales-invoice-${suffix}@example.test`, role: "owner" };
    next();
  };
  registerSalesRoutes(app, owner);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let customerId: number | undefined;
  const productIds: number[] = [];
  let orderId: number | undefined;
  const deliveryIds: number[] = [];

  try {
    const [customer] = await db.insert(customers).values({
      name: `Sales invoice customer ${suffix}`,
      status: "active",
    }).returning();
    customerId = customer.id;

    const fixtureProducts = await db.insert(products).values([
      { sku: `SINV-A-${suffix}`, name: `Invoice item A ${suffix}`, status: "active" },
      { sku: `SINV-B-${suffix}`, name: `Invoice item B ${suffix}`, status: "active" },
      { sku: `SINV-C-${suffix}`, name: `Invoice item C ${suffix}`, status: "active" },
    ]).returning();
    productIds.push(...fixtureProducts.map((product) => product.id));

    const [order] = await db.insert(salesOrders).values({
      orderNumber: `SO-${new Date().getUTCFullYear()}-${suffix.slice(0, 8)}`,
      customerId,
      status: "fulfilled",
      orderDate: "2026-11-10",
      fulfilledAt: new Date("2026-11-12T12:00:00.000Z"),
    }).returning();
    orderId = order.id;

    const orderLines = await db.insert(salesOrderLines).values([
      { salesOrderId: order.id, productId: productIds[0]!, quantity: 5, unitPriceZmw: "12.34" },
      { salesOrderId: order.id, productId: productIds[1]!, quantity: 3, unitPriceZmw: "0.17" },
      { salesOrderId: order.id, productId: productIds[2]!, quantity: 4, unitPriceZmw: "0.03" },
    ]).returning();

    const [firstDelivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `DN-${new Date().getUTCFullYear()}-${suffix.slice(0, 6)}A`,
      salesOrderId: order.id,
      deliveryDate: "2026-11-11",
    }).returning();
    const [secondDelivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `DN-${new Date().getUTCFullYear()}-${suffix.slice(0, 6)}B`,
      salesOrderId: order.id,
      deliveryDate: "2026-11-12",
    }).returning();
    deliveryIds.push(firstDelivery.id, secondDelivery.id);

    await db.insert(salesDeliveryLines).values([
      { deliveryId: firstDelivery.id, salesOrderLineId: orderLines[0]!.id, quantity: 2 },
      { deliveryId: firstDelivery.id, salesOrderLineId: orderLines[1]!.id, quantity: 1 },
      { deliveryId: firstDelivery.id, salesOrderLineId: orderLines[2]!.id, quantity: 3 },
      { deliveryId: secondDelivery.id, salesOrderLineId: orderLines[0]!.id, quantity: 3 },
      { deliveryId: secondDelivery.id, salesOrderLineId: orderLines[1]!.id, quantity: 2 },
      { deliveryId: secondDelivery.id, salesOrderLineId: orderLines[2]!.id, quantity: 1 },
    ]);

    const response = await fetch(`${baseUrl}/api/sales-orders`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { orders: any[] };
    const savedOrder = payload.orders.find((item) => item.id === order.id);
    assert.ok(savedOrder, "the created order should be returned");

    assert.equal(savedOrder.totalZmw, "62.33", "the order invoice keeps the complete order total");
    assert.equal(savedOrder.deliveredZmw, "62.33", "the recorded deliveries add up to the order value");
    const deliveriesByNumber = new Map(savedOrder.deliveries.map((delivery: any) => [delivery.deliveryNumber, delivery]));
    const first = deliveriesByNumber.get(firstDelivery.deliveryNumber) as any;
    const second = deliveriesByNumber.get(secondDelivery.deliveryNumber) as any;
    assert.ok(first, "the first delivery should have its own invoice data");
    assert.ok(second, "the second delivery should have its own invoice data");

    assert.equal(first.deliveryDate, "2026-11-11");
    assert.equal(first.totalZmw, "24.94");
    assert.deepEqual(first.lines.map((line: any) => [
      line.productName, line.quantity, line.unitPriceZmw, line.lineTotalZmw,
    ]).sort((left: any[], right: any[]) => String(left[0]).localeCompare(String(right[0]))), [
      [`Invoice item A ${suffix}`, 2, "12.34", "24.68"],
      [`Invoice item B ${suffix}`, 1, "0.17", "0.17"],
      [`Invoice item C ${suffix}`, 3, "0.03", "0.09"],
    ].sort(([left], [right]) => String(left).localeCompare(String(right))));

    assert.equal(second.deliveryDate, "2026-11-12");
    assert.equal(second.totalZmw, "37.39");
    assert.deepEqual(second.lines.map((line: any) => [
      line.productName, line.quantity, line.unitPriceZmw, line.lineTotalZmw,
    ]).sort((left: any[], right: any[]) => String(left[0]).localeCompare(String(right[0]))), [
      [`Invoice item A ${suffix}`, 3, "12.34", "37.02"],
      [`Invoice item B ${suffix}`, 2, "0.17", "0.34"],
      [`Invoice item C ${suffix}`, 1, "0.03", "0.03"],
    ].sort(([left], [right]) => String(left).localeCompare(String(right))));
    assert.equal(
      toCents(first.totalZmw) + toCents(second.totalZmw),
      toCents(savedOrder.totalZmw),
      "delivery-specific totals should reconcile to the full order total",
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (deliveryIds.length) {
        await client.query("DELETE FROM sales_delivery_lines WHERE delivery_id = ANY($1::int[])", [deliveryIds]);
        await client.query("DELETE FROM sales_deliveries WHERE id = ANY($1::int[])", [deliveryIds]);
      }
      if (orderId) {
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [orderId]);
        await client.query("DELETE FROM sales_orders WHERE id = $1", [orderId]);
      }
      if (productIds.length) await client.query("DELETE FROM products WHERE id = ANY($1::int[])", [productIds]);
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }
});
