import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { eq, inArray } from "drizzle-orm";
import test, { after } from "node:test";
import {
  inventoryMovementEvidence, inventoryMovements, products,
} from "../shared/schema";

after(async () => {
  if (process.env.DATABASE_URL) {
    const { pool } = await import("./db");
    await pool.end();
  }
});

function zipEntries(archive: Buffer) {
  const endOffset = archive.length - 22;
  assert.equal(archive.readUInt32LE(endOffset), 0x06054b50);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  const files = new Map<string, Buffer>();
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const fileNameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const fileName = archive.subarray(cursor + 46, cursor + 46 + fileNameLength).toString("utf8");
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    files.set(fileName, archive.subarray(dataOffset, dataOffset + compressedSize));
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return files;
}

test("selected count evidence downloads as one archive grouped by count record", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db, pool }, { registerInventoryRoutes }] = await Promise.all([
    import("./db"),
    import("./inventory-routes"),
  ]);
  const suffix = randomUUID();
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = {
      clerkUserId: `count-archive-${suffix}`,
      email: `count-archive-${suffix}@example.test`,
      role: "owner",
    };
    next();
  };
  registerInventoryRoutes(app, owner);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const productIds: number[] = [];
  const movementIds: number[] = [];
  try {
    const productRows = await db.insert(products).values([
      { sku: `CNT-ARC-1-${suffix}`, name: `Count archive one ${suffix}`, status: "active" },
      { sku: `CNT-ARC-2-${suffix}`, name: `Count archive two ${suffix}`, status: "active" },
      { sku: `CNT-ARC-3-${suffix}`, name: `Count archive non-count ${suffix}`, status: "active" },
      { sku: `CNT-ARC-4-${suffix}`, name: `Count archive empty evidence ${suffix}`, status: "active" },
    ]).returning();
    productIds.push(...productRows.map(({ id }) => id));
    const [firstProduct, secondProduct, nonCountProduct, noEvidenceProduct] = productRows;
    assert.ok(firstProduct && secondProduct && nonCountProduct && noEvidenceProduct);

    const [firstMovement, secondMovement, nonCountMovement, noEvidenceMovement] = await db.insert(inventoryMovements).values([
      {
        productId: firstProduct.id, kind: "opening_stock", quantityDelta: 2,
        reason: "Archive fixture", evidenceFileName: "legacy-count.pdf",
        evidenceMimeType: "application/pdf", evidenceData: Buffer.from("%PDF-legacy"),
        sourceKey: `count-archive-${suffix}-one`,
      },
      {
        productId: secondProduct.id, kind: "opening_stock", quantityDelta: 3,
        reason: "Archive fixture", sourceKey: `count-archive-${suffix}-two`,
      },
      {
        productId: nonCountProduct.id, kind: "adjustment", quantityDelta: 1,
        reason: "Archive fixture", sourceKey: `count-archive-${suffix}-non-count`,
      },
      {
        productId: noEvidenceProduct.id, kind: "opening_stock", quantityDelta: 1,
        reason: "Archive fixture", sourceKey: `count-archive-${suffix}-empty-evidence`,
      },
    ]).returning();
    movementIds.push(firstMovement.id, secondMovement.id, nonCountMovement.id, noEvidenceMovement.id);
    const evidence = await db.insert(inventoryMovementEvidence).values([
      {
        movementId: firstMovement.id, fileName: "recount photo.jpg", mimeType: "image/jpeg",
        data: Buffer.from([0xff, 0xd8, 0xff, 1, 2]),
      },
      {
        movementId: secondMovement.id, fileName: "signed sheet.pdf", mimeType: "application/pdf",
        data: Buffer.from("%PDF-signed"),
      },
      {
        movementId: secondMovement.id, fileName: "signed sheet.pdf", mimeType: "application/pdf",
        data: Buffer.from("%PDF-second-copy"),
      },
    ]).returning();

    const movementCountBefore = await db.select().from(inventoryMovements)
      .where(inArray(inventoryMovements.id, movementIds));
    const evidenceCountBefore = await db.select().from(inventoryMovementEvidence)
      .where(inArray(inventoryMovementEvidence.movementId, [firstMovement.id, secondMovement.id]));
    const response = await fetch(`${baseUrl}/api/inventory/opening-evidence/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ movementIds: [firstMovement.id, secondMovement.id] }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/zip/);
    assert.match(response.headers.get("content-disposition") ?? "", /count-evidence-selected-records\.zip/);
    const files = zipEntries(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual([...files.keys()], [
      `count-${firstMovement.id}/01-legacy-count.pdf`,
      `count-${firstMovement.id}/02-recount photo.jpg`,
      `count-${secondMovement.id}/01-signed sheet.pdf`,
      `count-${secondMovement.id}/02-signed sheet.pdf`,
    ]);
    assert.deepEqual(files.get(`count-${firstMovement.id}/01-legacy-count.pdf`), Buffer.from("%PDF-legacy"));
    assert.deepEqual(files.get(`count-${firstMovement.id}/02-recount photo.jpg`), Buffer.from([0xff, 0xd8, 0xff, 1, 2]));
    assert.deepEqual(files.get(`count-${secondMovement.id}/01-signed sheet.pdf`), Buffer.from("%PDF-signed"));
    assert.deepEqual(files.get(`count-${secondMovement.id}/02-signed sheet.pdf`), Buffer.from("%PDF-second-copy"));

    const [invalidCount, invalidKind, duplicateIds, noEvidence] = await Promise.all([
      fetch(`${baseUrl}/api/inventory/opening-evidence/archive`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ movementIds: [firstMovement.id] }),
      }),
      fetch(`${baseUrl}/api/inventory/opening-evidence/archive`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ movementIds: [firstMovement.id, nonCountMovement.id] }),
      }),
      fetch(`${baseUrl}/api/inventory/opening-evidence/archive`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ movementIds: [firstMovement.id, firstMovement.id] }),
      }),
      fetch(`${baseUrl}/api/inventory/opening-evidence/archive`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ movementIds: [firstMovement.id, noEvidenceMovement.id] }),
      }),
    ]);
    assert.equal(invalidCount.status, 400);
    assert.equal(invalidKind.status, 404);
    assert.equal(duplicateIds.status, 400);
    assert.equal(noEvidence.status, 400);
    const movementCountAfter = await db.select().from(inventoryMovements)
      .where(inArray(inventoryMovements.id, movementIds));
    const evidenceCountAfter = await db.select().from(inventoryMovementEvidence)
      .where(inArray(inventoryMovementEvidence.movementId, [firstMovement.id, secondMovement.id]));
    assert.equal(movementCountBefore.length, 4);
    assert.equal(evidenceCountBefore.length, evidence.length);
    assert.equal(movementCountAfter.length, movementCountBefore.length);
    assert.equal(evidenceCountAfter.length, evidenceCountBefore.length);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (movementIds.length) {
      await pool.query("ALTER TABLE inventory_movement_evidence DISABLE TRIGGER inventory_movement_evidence_immutable");
      try {
        await pool.query(
          "DELETE FROM inventory_movement_evidence WHERE movement_id = ANY($1::int[])",
          [movementIds],
        );
      } finally {
        await pool.query("ALTER TABLE inventory_movement_evidence ENABLE TRIGGER inventory_movement_evidence_immutable");
      }
      await db.delete(inventoryMovements).where(inArray(inventoryMovements.id, movementIds));
    }
    if (productIds.length) await db.delete(products).where(inArray(products.id, productIds));
  }
});
