import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import test from "node:test";
import {
  inventoryMovementEvidence, inventoryMovements, journalEntries, journalLines, products,
} from "../shared/schema";

test("appending opening-count evidence preserves the posted count and prior files", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db, pool }, { registerInventoryRoutes }] = await Promise.all([
    import("./db"),
    import("./inventory-routes"),
  ]);
  const suffix = randomUUID();
  const actorEmail = `opening-evidence-append-${suffix}@example.test`;
  const app = express();
  app.use(express.raw({ type: "multipart/form-data", limit: "5mb" }));
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerInventoryRoutes(app, owner);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let productId: number | undefined;
  const movementIds: number[] = [];

  const formData = (
    fields: Record<string, string>,
    files: { fileName: string; mimeType: string; data: Buffer }[],
    boundary: string,
  ) => {
    const chunks: Buffer[] = [];
    for (const [name, value] of Object.entries(fields)) {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ));
    }
    for (const file of files) {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="evidence"; filename="${file.fileName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      ));
      chunks.push(file.data, Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return Buffer.concat(chunks);
  };
  const upload = async (path: string, fields: Record<string, string>, files: {
    fileName: string; mimeType: string; data: Buffer;
  }[]) => {
    const boundary = `count-${randomUUID()}`;
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: formData(fields, files, boundary),
    });
  };
  const evidenceFile = (fileName: string, text: string) => ({
    fileName,
    mimeType: "application/pdf",
    data: Buffer.from(`%PDF-1.7 ${text}`),
  });

  try {
    const [product] = await db.insert(products).values({
      sku: `EVA-${suffix}`,
      name: `Evidence append ${suffix}`,
      status: "active",
      purchaseCurrency: "CNY",
    }).returning();
    productId = product.id;

    const openingResponse = await upload("/api/inventory/opening-stock", {
      productId: String(productId),
      quantity: "8",
      unitCostZmw: "12.50",
      effectiveAt: "2026-11-19",
      memo: "Opening count with original evidence",
    }, [
      evidenceFile("initial-count.pdf", "initial worksheet"),
      evidenceFile("initial-photo.pdf", "initial photo"),
    ]);
    const openingPayload = await openingResponse.json() as any;
    assert.equal(openingResponse.status, 201, JSON.stringify(openingPayload));
    const openingMovementId = openingPayload.movement.id as number;
    movementIds.push(openingMovementId);

    const [movementBefore] = await db.select().from(inventoryMovements)
      .where(eq(inventoryMovements.id, openingMovementId));
    const journalBefore = await db.select().from(journalEntries)
      .where(and(
        eq(journalEntries.sourceType, "opening_stock"),
        eq(journalEntries.sourceId, openingMovementId),
      ));
    const linesBefore = journalBefore.length
      ? await db.select().from(journalLines).where(eq(journalLines.journalEntryId, journalBefore[0]!.id))
      : [];
    assert.equal(journalBefore.length, 1);
    assert.equal(movementBefore?.quantityDelta, 8);

    const invalidUpload = await upload(`/api/inventory/opening-stock/${openingMovementId}/evidence`, {}, [
      { fileName: "not-a-pdf.pdf", mimeType: "application/pdf", data: Buffer.from("not a PDF") },
    ]);
    assert.equal(invalidUpload.status, 400);

    const appendResponse = await upload(`/api/inventory/opening-stock/${openingMovementId}/evidence`, {}, [
      evidenceFile("late-count.pdf", "late worksheet"),
    ]);
    const appendPayload = await appendResponse.json() as any;
    assert.equal(appendResponse.status, 201, JSON.stringify(appendPayload));
    assert.equal(appendPayload.evidenceFiles.length, 1);

    const tooManyFilesResponse = await upload(`/api/inventory/opening-stock/${openingMovementId}/evidence`, {}, [
      evidenceFile("late-2.pdf", "second late worksheet"),
      evidenceFile("late-3.pdf", "third late worksheet"),
      evidenceFile("late-4.pdf", "fourth late worksheet"),
    ]);
    assert.equal(tooManyFilesResponse.status, 400);

    const [nonCountMovement] = await db.insert(inventoryMovements).values({
      productId, kind: "adjustment", quantityDelta: 1,
      reason: "Evidence append non-count fixture",
      sourceKey: `evidence-append-adjustment-${suffix}`,
    }).returning();
    movementIds.push(nonCountMovement.id);
    const nonCountResponse = await upload(`/api/inventory/opening-stock/${nonCountMovement.id}/evidence`, {}, [
      evidenceFile("invalid-target.pdf", "not an opening count"),
    ]);
    assert.equal(nonCountResponse.status, 404);

    const historyResponse = await fetch(`${baseUrl}/api/inventory/movements`);
    const historyPayload = await historyResponse.json() as any;
    assert.equal(historyResponse.status, 200);
    const historyRow = historyPayload.movements.find((row: any) => row.id === openingMovementId);
    assert.deepEqual(historyRow.evidenceFiles.map((file: any) => file.fileName), [
      "initial-count.pdf",
      "initial-photo.pdf",
      "late-count.pdf",
    ]);

    const [movementAfter] = await db.select().from(inventoryMovements)
      .where(eq(inventoryMovements.id, openingMovementId));
    const journalAfter = await db.select().from(journalEntries)
      .where(and(
        eq(journalEntries.sourceType, "opening_stock"),
        eq(journalEntries.sourceId, openingMovementId),
      ));
    const linesAfter = journalAfter.length
      ? await db.select().from(journalLines).where(eq(journalLines.journalEntryId, journalAfter[0]!.id))
      : [];
    assert.equal(movementAfter?.quantityDelta, movementBefore?.quantityDelta);
    assert.equal(journalAfter.length, journalBefore.length);
    assert.deepEqual(linesAfter, linesBefore);

    const evidenceRows = await db.select().from(inventoryMovementEvidence)
      .where(eq(inventoryMovementEvidence.movementId, openingMovementId));
    assert.equal(evidenceRows.length, 3);
    const appendedEvidenceId = appendPayload.evidenceFiles[0].id as number;
    await assert.rejects(
      pool.query("UPDATE inventory_movement_evidence SET data = $1 WHERE id = $2", [
        Buffer.from("%PDF-tampered"), appendedEvidenceId,
      ]),
      /cannot be changed or deleted/i,
    );
    await assert.rejects(
      pool.query("DELETE FROM inventory_movement_evidence WHERE id = $1", [appendedEvidenceId]),
      /cannot be changed or deleted/i,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (movementIds.length) {
      await pool.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      await pool.query(`
        DELETE FROM journal_lines
        WHERE journal_entry_id IN (
          SELECT id FROM journal_entries
          WHERE source_id = ANY($1::int[])
            AND source_type IN ('opening_stock', 'opening_stock_reversal')
        )
      `, [movementIds]);
      await pool.query(`
        DELETE FROM journal_entries
        WHERE source_id = ANY($1::int[])
          AND source_type IN ('opening_stock', 'opening_stock_reversal')
      `, [movementIds]);
      await pool.query("ALTER TABLE inventory_movement_evidence DISABLE TRIGGER inventory_movement_evidence_immutable");
      try {
        await pool.query("DELETE FROM inventory_movement_evidence WHERE movement_id = ANY($1::int[])", [movementIds]);
      } finally {
        await pool.query("ALTER TABLE inventory_movement_evidence ENABLE TRIGGER inventory_movement_evidence_immutable");
      }
      await db.delete(inventoryMovements).where(eq(inventoryMovements.productId, productId!));
    }
    if (productId) await db.delete(products).where(eq(products.id, productId));
    await pool.end();
  }
});
