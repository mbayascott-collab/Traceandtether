import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import test from "node:test";
import {
  salesDeliveryReceiptProofFileUrl,
  salesDeliveryReceiptProofUrl,
} from "../src/lib/api";
import {
  businessAuditLogs, customers, products, salesDeliveries, salesDeliveryLines, salesDeliveryReceiptProofs,
  salesDeliveryReceipts, salesOrderLines, salesOrders,
} from "../shared/schema";

test("customer purchase history keeps delivery notes, receipt details, and protected proof links connected", {
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
  const owner: RequestHandler = (req, res, next) => {
    const role = req.header("x-test-role") ?? "owner";
    if (role !== "owner") return res.status(403).json({ error: "Only an owner may download signed delivery proof." });
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
      quantity: 4,
      unitPriceZmw: "1.00",
    }).returning();
    orderLineId = orderLine.id;
    const [delivery, otherDelivery, legacyDelivery, noProofDelivery] = await db.insert(salesDeliveries).values([
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
      {
        deliveryNumber: `DN-LEG-${suffix.slice(0, 18)}`,
        salesOrderId: order.id,
        deliveryDate: "2026-11-18",
      },
      {
        deliveryNumber: `DN-NP-${suffix.slice(0, 20)}`,
        salesOrderId: order.id,
        deliveryDate: "2026-11-17",
      },
    ]).returning();
    deliveryIds.push(delivery.id, otherDelivery.id, legacyDelivery.id, noProofDelivery.id);
    await db.insert(salesDeliveryLines).values([
      { deliveryId: delivery.id, salesOrderLineId: orderLine.id, quantity: 1 },
      { deliveryId: otherDelivery.id, salesOrderLineId: orderLine.id, quantity: 1 },
      { deliveryId: legacyDelivery.id, salesOrderLineId: orderLine.id, quantity: 1 },
      { deliveryId: noProofDelivery.id, salesOrderLineId: orderLine.id, quantity: 1 },
    ]);
    const expectedFirstReceivedAt = new Date("2026-11-19T10:00:00.000Z");
    const expectedOtherReceivedAt = new Date("2026-11-19T11:00:00.000Z");
    const expectedLegacyReceivedAt = new Date("2026-11-18T09:30:00.000Z");
    const expectedNoProofReceivedAt = new Date("2026-11-17T09:00:00.000Z");
    const legacyFile = Buffer.from("%PDF-1.7 legacy signed delivery note");
    const [receipt, otherReceipt, legacyReceipt, noProofReceipt] = await db.insert(salesDeliveryReceipts).values([
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
      {
        deliveryId: legacyDelivery.id,
        receivedBy: "Legacy recipient",
        receivedAt: expectedLegacyReceivedAt,
        proofFileName: "legacy-signed-note.pdf",
        proofMimeType: "application/pdf",
        proofData: legacyFile,
      },
      {
        deliveryId: noProofDelivery.id,
        receivedBy: "Recipient without proof",
        receivedAt: expectedNoProofReceivedAt,
      },
    ]).returning();
    receiptIds.push(receipt.id, otherReceipt.id, legacyReceipt.id, noProofReceipt.id);

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
    const invalidUpload = await upload(
      delivery.id, "invalid-proof.txt", randomUUID(), Buffer.from("not a supported proof file"),
    );
    assert.equal(invalidUpload.response.status, 400, JSON.stringify(invalidUpload.payload));
    const additionalFormats = [
      {
        fileName: "signed-receipt.jpg",
        mimeType: "image/jpeg",
        data: Buffer.from([0xff, 0xd8, 0xff, 0x01]),
      },
      {
        fileName: "signed-receipt.png",
        mimeType: "image/png",
        data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
      },
      {
        fileName: "signed-receipt.webp",
        mimeType: "image/webp",
        data: Buffer.from("RIFF\x04\x00\x00\x00WEBP"),
      },
    ];
    const additionalUploads = [];
    for (const proof of additionalFormats) {
      const saved = await upload(delivery.id, proof.fileName, randomUUID(), proof.data);
      assert.equal(saved.response.status, 201, JSON.stringify(saved.payload));
      additionalUploads.push({ ...proof, proof: saved.payload.proof });
    }

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
    assert.equal(reloadedOrder.customerId, customer.id, "purchase history should retain its owning customer");
    assert.equal(reloadedOrder.customerName, customer.name);
    const reloadedDeliveries = new Map(reloadedOrder.deliveries.map((item: any) => [item.id, item]));
    const reloadedDelivery = reloadedDeliveries.get(delivery.id) as any;
    const reloadedOtherDelivery = reloadedDeliveries.get(otherDelivery.id) as any;
    const reloadedLegacyDelivery = reloadedDeliveries.get(legacyDelivery.id) as any;
    const reloadedNoProofDelivery = reloadedDeliveries.get(noProofDelivery.id) as any;
    assert.ok(reloadedDelivery, "the first delivery note should be returned after reload");
    assert.ok(reloadedOtherDelivery, "the other delivery note should be returned after reload");
    assert.ok(reloadedLegacyDelivery, "the legacy-proof delivery note should appear in purchase history");
    assert.ok(reloadedNoProofDelivery, "the delivery note without proof should appear in purchase history");
    assert.equal(reloadedDelivery.deliveryNumber, delivery.deliveryNumber);
    assert.equal(reloadedOtherDelivery.deliveryNumber, otherDelivery.deliveryNumber);
    assert.equal(reloadedLegacyDelivery.deliveryNumber, legacyDelivery.deliveryNumber);
    assert.equal(reloadedLegacyDelivery.deliveryDate, "2026-11-18");
    assert.deepEqual(
      reloadedDelivery.receipt.proofs.map((proof: any) => ({
        id: proof.id, fileName: proof.fileName, mimeType: proof.mimeType,
      })).sort(
        (left: any, right: any) => left.fileName.localeCompare(right.fileName),
      ),
      [
        { id: original.payload.proof.id, fileName: "signed-receipt.pdf", mimeType: "application/pdf" },
        { id: separate.payload.proof.id, fileName: "additional-receipt.pdf", mimeType: "application/pdf" },
        ...additionalUploads.map(({ proof }) => ({
          id: proof.id, fileName: proof.fileName, mimeType: proof.mimeType,
        })),
      ].sort((left, right) => left.fileName.localeCompare(right.fileName)),
      "all supported proof formats for the first note should remain listed after reload",
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
    assert.equal(reloadedLegacyDelivery.receipt.receivedBy, "Legacy recipient");
    assert.equal(new Date(reloadedLegacyDelivery.receipt.receivedAt).toISOString(), expectedLegacyReceivedAt.toISOString());
    assert.equal(reloadedLegacyDelivery.receipt.proofFileName, "legacy-signed-note.pdf");
    assert.equal(reloadedLegacyDelivery.receipt.proofMimeType, "application/pdf");
    assert.deepEqual(reloadedLegacyDelivery.receipt.proofs, [
      { id: null, fileName: "legacy-signed-note.pdf", mimeType: "application/pdf" },
    ]);
    assert.equal(reloadedNoProofDelivery.receipt.receivedBy, "Recipient without proof");
    assert.equal(new Date(reloadedNoProofDelivery.receipt.receivedAt).toISOString(), expectedNoProofReceivedAt.toISOString());

    const editedReceiptResponse = await fetch(
      `${baseUrl}/api/sales-deliveries/${delivery.id}/receipt-proof?${new URLSearchParams({
        receivedBy: "Updated recipient",
        receivedAt: "2026-11-20T13:00:00.000Z",
      })}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(),
      },
    );
    assert.equal(editedReceiptResponse.status, 200);
    const afterReceiptEditResponse = await fetch(`${baseUrl}/api/sales-orders`);
    const afterReceiptEditPayload = await afterReceiptEditResponse.json() as { orders: any[] };
    const afterReceiptEditOrder = afterReceiptEditPayload.orders.find((item) => item.id === order.id);
    const afterReceiptEditDelivery = afterReceiptEditOrder?.deliveries.find((item: any) => item.id === delivery.id);
    assert.equal(afterReceiptEditDelivery.receipt.receivedBy, "Updated recipient");
    assert.equal(new Date(afterReceiptEditDelivery.receipt.receivedAt).toISOString(), "2026-11-20T13:00:00.000Z");
    assert.deepEqual(
      afterReceiptEditDelivery.receipt.proofs.map((proof: any) => ({
        id: proof.id, fileName: proof.fileName, mimeType: proof.mimeType,
      })).sort((left: any, right: any) => left.id - right.id),
      reloadedDelivery.receipt.proofs.map((proof: any) => ({
        id: proof.id, fileName: proof.fileName, mimeType: proof.mimeType,
      })).sort((left: any, right: any) => left.id - right.id),
      "editing receipt details must preserve each signed proof and its download details",
    );

    const download = async (url: string, role = "owner") => fetch(new URL(url, baseUrl), {
      headers: { "x-test-role": role },
    });
    for (const [ownDeliveryId, proof] of [
      [delivery.id, { id: original.payload.proof.id, mimeType: "application/pdf", data: firstFile }],
      [delivery.id, {
        id: separate.payload.proof.id, mimeType: "application/pdf",
        data: Buffer.from("%PDF-1.7 additional signed receipt"),
      }],
      ...additionalUploads.map(({ proof, data }) => [
        delivery.id, { id: proof.id, mimeType: proof.mimeType, data },
      ] as const),
      [otherDelivery.id, { id: otherUpload.proof.id, mimeType: "application/pdf", data: otherFile }],
    ] as const) {
      const url = salesDeliveryReceiptProofFileUrl(ownDeliveryId, proof.id);
      assert.equal(url, `/api/sales-deliveries/${ownDeliveryId}/receipt-proofs/${proof.id}`);
      const response = await download(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), proof.mimeType);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(response.headers.get("content-disposition") ?? "", /^attachment;\s*filename="/i);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), proof.data);
    }
    const legacyUrl = salesDeliveryReceiptProofUrl(legacyDelivery.id);
    assert.equal(legacyUrl, `/api/sales-deliveries/${legacyDelivery.id}/receipt-proof`);
    const legacyDownload = await download(legacyUrl);
    assert.equal(legacyDownload.status, 200);
    assert.equal(legacyDownload.headers.get("content-type"), "application/pdf");
    assert.match(legacyDownload.headers.get("content-disposition") ?? "", /legacy-signed-note\.pdf/);
    assert.equal(legacyDownload.headers.get("cache-control"), "no-store");
    assert.equal(legacyDownload.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await legacyDownload.arrayBuffer()), legacyFile);

    for (const url of [
      salesDeliveryReceiptProofFileUrl(delivery.id, original.payload.proof.id),
      salesDeliveryReceiptProofUrl(legacyDelivery.id),
    ]) {
      const denied = await download(url, "manager");
      assert.equal(denied.status, 403);
      const denialBody = await denied.text();
      assert.doesNotMatch(denialBody, /signed-receipt|legacy-signed-note|application\/pdf|%PDF/);
    }

    for (const proofId of [original.payload.proof.id, separate.payload.proof.id]) {
      const mismatched = await download(salesDeliveryReceiptProofFileUrl(otherDelivery.id, proofId));
      assert.equal(mismatched.status, 404);
      assert.match((await mismatched.json() as any).error, /not found for this delivery note/i);
    }
    const reverseMismatch = await download(salesDeliveryReceiptProofFileUrl(delivery.id, otherUpload.proof.id));
    assert.equal(reverseMismatch.status, 404);
    assert.match((await reverseMismatch.json() as any).error, /not found for this delivery note/i);
    const missingProof = await download(salesDeliveryReceiptProofFileUrl(delivery.id, original.payload.proof.id + 100000000));
    assert.equal(missingProof.status, 404);
    assert.match((await missingProof.json() as any).error, /not found for this delivery note/i);
    const absentLegacyProof = await download(salesDeliveryReceiptProofUrl(noProofDelivery.id));
    assert.equal(absentLegacyProof.status, 404);
    assert.match((await absentLegacyProof.json() as any).error, /no signed proof is saved/i);
    const legacyProofOnWrongDelivery = await download(salesDeliveryReceiptProofUrl(otherDelivery.id));
    assert.equal(legacyProofOnWrongDelivery.status, 404);
    assert.match((await legacyProofOnWrongDelivery.json() as any).error, /no signed proof is saved/i);

    const savedProofs = await db.select().from(salesDeliveryReceiptProofs)
      .where(eq(salesDeliveryReceiptProofs.deliveryId, delivery.id));
    assert.equal(savedProofs.length, 5);
    const otherSavedProofs = await db.select().from(salesDeliveryReceiptProofs)
      .where(eq(salesDeliveryReceiptProofs.deliveryId, otherDelivery.id));
    assert.equal(otherSavedProofs.length, 1);
    for (const receiptId of receiptIds) {
      const auditEntries = await db.select().from(businessAuditLogs).where(and(
        eq(businessAuditLogs.entityType, "sales_delivery_receipt"),
        eq(businessAuditLogs.entityId, receiptId),
      ));
      assert.equal(auditEntries.length, receiptId === receipt.id ? 6 : receiptId === otherReceipt.id ? 1 : 0);
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
