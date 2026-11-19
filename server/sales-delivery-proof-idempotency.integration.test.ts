import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import test from "node:test";
import {
  businessAuditLogs, customers, products, salesDeliveries, salesDeliveryLines, salesDeliveryReceiptProofs,
  salesDeliveryReceipts, salesOrderLines, salesOrders,
} from "../shared/schema";

test("delivery proof uploads remain attached to their note without changing receipt details", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db }, { registerSalesRoutes }] = await Promise.all([
    import("./db"),
    import("./sales-routes"),
  ]);
  const suffix = randomUUID();
  const actorEmail = `proof-retry-${suffix}@example.test`;
  const app = express();
  app.use("/api/sales-deliveries/:id/receipt-proofs", express.raw({
    type: "application/octet-stream",
    limit: "5mb",
  }));
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `proof-retry-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerSalesRoutes(app, owner);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let customerId: number | undefined;
  let productId: number | undefined;
  let orderId: number | undefined;
  let orderLineId: number | undefined;
  const deliveryIds: number[] = [];
  const receiptIds: number[] = [];

  const upload = async (deliveryId: number, fileName: string, key: string, file: Buffer) => {
    const response = await fetch(`${baseUrl}/api/sales-deliveries/${deliveryId}/receipt-proofs?${new URLSearchParams({ fileName })}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Idempotency-Key": key },
      body: new Uint8Array(file),
    });
    return { response, payload: await response.json() as any };
  };

  try {
    const [customer] = await db.insert(customers).values({ name: `Proof retry customer ${suffix}` }).returning();
    customerId = customer.id;
    const [order] = await db.insert(salesOrders).values({
      orderNumber: `PR-${suffix.slice(0, 24)}`,
      customerId: customer.id,
      status: "fulfilled",
      orderDate: "2026-11-19",
    }).returning();
    orderId = order.id;
    const [product] = await db.insert(products).values({
      sku: `PROOF-${suffix.slice(0, 20)}`,
      name: `Proof test product ${suffix}`,
      status: "active",
    }).returning();
    productId = product.id;
    const [orderLine] = await db.insert(salesOrderLines).values({
      salesOrderId: order.id,
      productId: product.id,
      quantity: 2,
      unitPriceZmw: "1.00",
    }).returning();
    orderLineId = orderLine.id;
    const [delivery, otherDelivery] = await db.insert(salesDeliveries).values([
      {
        deliveryNumber: `DN-PR-${suffix.slice(0, 20)}`,
        salesOrderId: order.id,
        deliveryDate: "2026-11-19",
      },
      {
        deliveryNumber: `DN-PR2-${suffix.slice(0, 18)}`,
        salesOrderId: order.id,
        deliveryDate: "2026-11-19",
      },
    ]).returning();
    deliveryIds.push(delivery.id, otherDelivery.id);
    await db.insert(salesDeliveryLines).values([
      { deliveryId: delivery.id, salesOrderLineId: orderLine.id, quantity: 1 },
      { deliveryId: otherDelivery.id, salesOrderLineId: orderLine.id, quantity: 1 },
    ]);
    const expectedFirstReceivedAt = new Date("2026-11-19T10:00:00.000Z");
    const expectedOtherReceivedAt = new Date("2026-11-19T11:00:00.000Z");
    const [receipt, otherReceipt] = await db.insert(salesDeliveryReceipts).values([
      {
        deliveryId: delivery.id,
        receivedBy: "Test recipient",
        receivedAt: expectedFirstReceivedAt,
      },
      {
        deliveryId: otherDelivery.id,
        receivedBy: "Other test recipient",
        receivedAt: expectedOtherReceivedAt,
      },
    ]).returning();
    receiptIds.push(receipt.id, otherReceipt.id);

    const firstKey = randomUUID();
    const firstFile = Buffer.from("%PDF-1.7 first signed receipt");
    const original = await upload(delivery.id, "signed-receipt.pdf", firstKey, firstFile);
    assert.equal(original.response.status, 201, JSON.stringify(original.payload));

    const retry = await upload(delivery.id, "signed-receipt.pdf", firstKey, firstFile);
    assert.equal(retry.response.status, 200, JSON.stringify(retry.payload));
    assert.deepEqual(retry.payload.proof, original.payload.proof);

    const keyReuseWithDifferentContent = await upload(
      delivery.id, "different-proof.pdf", firstKey, Buffer.from("%PDF-1.7 different"),
    );
    assert.equal(keyReuseWithDifferentContent.response.status, 409);

    const separate = await upload(
      delivery.id, "additional-receipt.pdf", randomUUID(), Buffer.from("%PDF-1.7 additional signed receipt"),
    );
    assert.equal(separate.response.status, 201, JSON.stringify(separate.payload));
    assert.notEqual(separate.payload.proof.id, original.payload.proof.id);

    const otherFile = Buffer.from("%PDF-1.7 proof for another delivery");
    const otherUploadResponse = await fetch(
      `${baseUrl}/api/sales-deliveries/${otherDelivery.id}/receipt-proofs?${new URLSearchParams({ fileName: "other-delivery.pdf" })}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "Idempotency-Key": randomUUID() },
        body: new Uint8Array(otherFile),
      },
    );
    const otherUpload = await otherUploadResponse.json() as any;
    assert.equal(otherUploadResponse.status, 201, JSON.stringify(otherUpload));

    const reloadResponse = await fetch(`${baseUrl}/api/sales-orders`);
    assert.equal(reloadResponse.status, 200);
    const reloadPayload = await reloadResponse.json() as { orders: any[] };
    const reloadedOrder = reloadPayload.orders.find((item) => item.id === order.id);
    assert.ok(reloadedOrder, "the order should remain available after uploads");
    const reloadedDeliveries = new Map(reloadedOrder.deliveries.map((item: any) => [item.id, item]));
    const reloadedDelivery = reloadedDeliveries.get(delivery.id) as any;
    const reloadedOtherDelivery = reloadedDeliveries.get(otherDelivery.id) as any;
    assert.ok(reloadedDelivery, "the first delivery note should be returned after reload");
    assert.ok(reloadedOtherDelivery, "the other delivery note should be returned after reload");
    assert.deepEqual(
      reloadedDelivery.receipt.proofs.map((proof: any) => ({ id: proof.id, fileName: proof.fileName })).sort(
        (left: any, right: any) => left.fileName.localeCompare(right.fileName),
      ),
      [
        { id: original.payload.proof.id, fileName: "signed-receipt.pdf" },
        { id: separate.payload.proof.id, fileName: "additional-receipt.pdf" },
      ].sort((left, right) => left.fileName.localeCompare(right.fileName)),
      "both files for the first note should remain listed after reload",
    );
    assert.deepEqual(
      reloadedOtherDelivery.receipt.proofs.map((proof: any) => ({ id: proof.id, fileName: proof.fileName })),
      [{ id: otherUpload.proof.id, fileName: "other-delivery.pdf" }],
      "the other note should list only its own proof",
    );
    assert.equal(reloadedDelivery.receipt.receivedBy, "Test recipient");
    assert.equal(new Date(reloadedDelivery.receipt.receivedAt).toISOString(), expectedFirstReceivedAt.toISOString());
    assert.equal(reloadedOtherDelivery.receipt.receivedBy, "Other test recipient");
    assert.equal(new Date(reloadedOtherDelivery.receipt.receivedAt).toISOString(), expectedOtherReceivedAt.toISOString());

    const download = async (deliveryId: number, proofId: number) => fetch(
      `${baseUrl}/api/sales-deliveries/${deliveryId}/receipt-proofs/${proofId}`,
    );
    for (const [ownDeliveryId, proof] of [
      [delivery.id, { id: original.payload.proof.id, data: firstFile }],
      [delivery.id, { id: separate.payload.proof.id, data: Buffer.from("%PDF-1.7 additional signed receipt") }],
      [otherDelivery.id, { id: otherUpload.proof.id, data: otherFile }],
    ] as const) {
      const response = await download(ownDeliveryId, proof.id);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), proof.data);
    }
    for (const proofId of [original.payload.proof.id, separate.payload.proof.id]) {
      assert.equal((await download(otherDelivery.id, proofId)).status, 404);
    }
    assert.equal((await download(delivery.id, otherUpload.proof.id)).status, 404);

    const savedProofs = await db.select().from(salesDeliveryReceiptProofs)
      .where(eq(salesDeliveryReceiptProofs.deliveryId, delivery.id));
    assert.equal(savedProofs.length, 2);
    const otherSavedProofs = await db.select().from(salesDeliveryReceiptProofs)
      .where(eq(salesDeliveryReceiptProofs.deliveryId, otherDelivery.id));
    assert.equal(otherSavedProofs.length, 1);
    for (const receiptId of receiptIds) {
      const auditEntries = await db.select().from(businessAuditLogs).where(and(
        eq(businessAuditLogs.entityType, "sales_delivery_receipt"),
        eq(businessAuditLogs.entityId, receiptId),
      ));
      assert.equal(auditEntries.length, receiptId === receipt.id ? 2 : 1);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const receiptId of receiptIds) {
      await db.delete(businessAuditLogs).where(and(
        eq(businessAuditLogs.entityType, "sales_delivery_receipt"),
        eq(businessAuditLogs.entityId, receiptId),
      ));
    }
    for (const deliveryId of deliveryIds) {
      await db.delete(salesDeliveryReceiptProofs).where(eq(salesDeliveryReceiptProofs.deliveryId, deliveryId));
      await db.delete(salesDeliveryReceipts).where(eq(salesDeliveryReceipts.deliveryId, deliveryId));
      await db.delete(salesDeliveryLines).where(eq(salesDeliveryLines.deliveryId, deliveryId));
    }
    if (deliveryIds.length) await db.delete(salesDeliveries).where(inArray(salesDeliveries.id, deliveryIds));
    if (orderLineId) await db.delete(salesOrderLines).where(eq(salesOrderLines.id, orderLineId));
    if (orderId) await db.delete(salesOrders).where(eq(salesOrders.id, orderId));
    if (productId) await db.delete(products).where(eq(products.id, productId));
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  }
});
