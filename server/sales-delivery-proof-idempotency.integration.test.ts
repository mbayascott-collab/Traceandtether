import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import test from "node:test";
import {
  businessAuditLogs, customers, salesDeliveries, salesDeliveryReceiptProofs, salesDeliveryReceipts, salesOrders,
} from "../shared/schema";

test("retrying a proof upload returns the saved file without blocking a separate upload", {
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
  let orderId: number | undefined;
  let deliveryId: number | undefined;
  let receiptId: number | undefined;

  const upload = async (fileName: string, key: string, file: Buffer) => {
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
    const [delivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `DN-PR-${suffix.slice(0, 20)}`,
      salesOrderId: order.id,
      deliveryDate: "2026-11-19",
    }).returning();
    deliveryId = delivery.id;
    const [receipt] = await db.insert(salesDeliveryReceipts).values({
      deliveryId: delivery.id,
      receivedBy: "Test recipient",
      receivedAt: new Date("2026-11-19T10:00:00.000Z"),
    }).returning();
    receiptId = receipt.id;

    const firstKey = randomUUID();
    const firstFile = Buffer.from("%PDF-1.7 first signed receipt");
    const original = await upload("signed-receipt.pdf", firstKey, firstFile);
    assert.equal(original.response.status, 201, JSON.stringify(original.payload));

    const retry = await upload("signed-receipt.pdf", firstKey, firstFile);
    assert.equal(retry.response.status, 200, JSON.stringify(retry.payload));
    assert.deepEqual(retry.payload.proof, original.payload.proof);

    const keyReuseWithDifferentContent = await upload("different-proof.pdf", firstKey, Buffer.from("%PDF-1.7 different"));
    assert.equal(keyReuseWithDifferentContent.response.status, 409);

    const separate = await upload("additional-receipt.pdf", randomUUID(), Buffer.from("%PDF-1.7 additional signed receipt"));
    assert.equal(separate.response.status, 201, JSON.stringify(separate.payload));
    assert.notEqual(separate.payload.proof.id, original.payload.proof.id);

    const savedProofs = await db.select().from(salesDeliveryReceiptProofs)
      .where(eq(salesDeliveryReceiptProofs.deliveryId, delivery.id));
    assert.equal(savedProofs.length, 2);
    const auditEntries = await db.select().from(businessAuditLogs).where(and(
      eq(businessAuditLogs.entityType, "sales_delivery_receipt"),
      eq(businessAuditLogs.entityId, receipt.id),
    ));
    assert.equal(auditEntries.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (receiptId) {
      await db.delete(businessAuditLogs).where(and(
        eq(businessAuditLogs.entityType, "sales_delivery_receipt"),
        eq(businessAuditLogs.entityId, receiptId),
      ));
      await db.delete(salesDeliveryReceiptProofs).where(eq(salesDeliveryReceiptProofs.deliveryId, deliveryId!));
      await db.delete(salesDeliveryReceipts).where(eq(salesDeliveryReceipts.id, receiptId));
    }
    if (deliveryId) await db.delete(salesDeliveries).where(eq(salesDeliveries.id, deliveryId));
    if (orderId) await db.delete(salesOrders).where(eq(salesOrders.id, orderId));
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  }
});
