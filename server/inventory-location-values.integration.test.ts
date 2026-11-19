import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import test from "node:test";
import {
  inventoryLocations, inventoryMovements, journalEntries, journalLines, products,
} from "../shared/schema";
import { cents, ensureAccountingAccounts, formatCents, postJournal } from "./accounting-posting";

test("inventory endpoint reconciles location values and quantities with ledger balances", {
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
      clerkUserId: `inventory-location-${suffix}`,
      email: `inventory-location-${suffix}@example.test`,
      role: "owner",
    };
    next();
  };
  registerInventoryRoutes(app, owner);
  app.use(((error: unknown, _req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  }) as express.ErrorRequestHandler);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const productIds: number[] = [];
  const locationIds: number[] = [];
  const movementIds: number[] = [];
  const entryIds: number[] = [];

  try {
    const locations = await db.insert(inventoryLocations).values([
      { name: `Location reconciliation A ${suffix}` },
      { name: `Location reconciliation B ${suffix}` },
      { name: `Location reconciliation inactive ${suffix}`, active: false },
    ]).returning();
    locationIds.push(...locations.map(({ id }) => id));
    const [locationA, locationB, inactiveLocation] = locations;
    assert.ok(locationA && locationB && inactiveLocation);

    const productsForTest = await db.insert(products).values([
      { sku: `LOC-1-${suffix}`, name: `Location reconciliation product one ${suffix}`, status: "active" },
      { sku: `LOC-2-${suffix}`, name: `Location reconciliation product two ${suffix}`, status: "active" },
    ]).returning();
    productIds.push(...productsForTest.map(({ id }) => id));
    const [firstProduct, secondProduct] = productsForTest;
    assert.ok(firstProduct && secondProduct);

    const movements = await db.insert(inventoryMovements).values([
      { productId: firstProduct.id, locationId: locationA.id, kind: "opening_stock", quantityDelta: 1, reason: "Location value regression fixture", sourceKey: `location-value-${suffix}-1-a` },
      { productId: firstProduct.id, locationId: locationB.id, kind: "opening_stock", quantityDelta: 2, reason: "Location value regression fixture", sourceKey: `location-value-${suffix}-1-b` },
      { productId: firstProduct.id, locationId: inactiveLocation.id, kind: "opening_stock", quantityDelta: 1, reason: "Location value regression fixture", sourceKey: `location-value-${suffix}-1-inactive` },
      { productId: firstProduct.id, locationId: null, kind: "opening_stock", quantityDelta: 2, reason: "Location value regression fixture", sourceKey: `location-value-${suffix}-1-unassigned` },
      { productId: secondProduct.id, locationId: locationA.id, kind: "opening_stock", quantityDelta: 2, reason: "Location value regression fixture", sourceKey: `location-value-${suffix}-2-a` },
      { productId: secondProduct.id, locationId: locationB.id, kind: "opening_stock", quantityDelta: 1, reason: "Location value regression fixture", sourceKey: `location-value-${suffix}-2-b` },
      { productId: secondProduct.id, locationId: null, kind: "opening_stock", quantityDelta: 1, reason: "Location value regression fixture", sourceKey: `location-value-${suffix}-2-unassigned` },
    ]).returning();
    movementIds.push(...movements.map(({ id }) => id));

    const inventoryAccount = await db.transaction(async (tx) => {
      const accountMap = await ensureAccountingAccounts(tx);
      for (const { productId, amount, label } of [
        { productId: firstProduct.id, amount: "0.10", label: "one" },
        { productId: secondProduct.id, amount: "0.03", label: "two" },
      ]) {
        const entry = await postJournal(tx, {
          sourceKey: `location-value-journal-${suffix}-${label}`,
          sourceType: "inventory_location_regression",
          sourceId: productId,
          memo: "Inventory location value regression fixture",
          lines: [
            { accountKey: "inventory", productId, debitZmw: amount, description: "Fixture inventory" },
            { accountKey: "opening_balance_equity", creditZmw: amount, description: "Fixture opening equity" },
          ],
        });
        entryIds.push(entry.id);
      }
      return accountMap.get("inventory")!;
    });
    assert.ok(inventoryAccount);

    const response = await fetch(`${baseUrl}/api/inventory`);
    const payload = await response.json() as { inventory: any[] };
    assert.equal(response.status, 200, JSON.stringify(payload));
    const inventoryByProduct = new Map(
      payload.inventory.filter((item) => productIds.includes(item.id)).map((item) => [item.id, item]),
    );
    assert.equal(inventoryByProduct.size, productsForTest.length);

    const accountLines = await db.select({
      productId: journalLines.productId,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines).where(and(
      eq(journalLines.accountId, inventoryAccount.id),
      inArray(journalLines.productId, productIds),
    ));
    const accountBalanceByProduct = new Map<number, bigint>();
    for (const line of accountLines) {
      if (line.productId === null) continue;
      accountBalanceByProduct.set(
        line.productId,
        (accountBalanceByProduct.get(line.productId) ?? 0n) + cents(line.debitZmw) - cents(line.creditZmw),
      );
    }

    const expected = [
      { product: firstProduct, onHand: 6, quantities: [[locationA.id, 1], [locationB.id, 2], [inactiveLocation.id, 1], [null, 2]] as const },
      { product: secondProduct, onHand: 4, quantities: [[locationA.id, 2], [locationB.id, 1], [null, 1]] as const },
    ];
    for (const fixture of expected) {
      const item = inventoryByProduct.get(fixture.product.id);
      assert.ok(item, fixture.product.name);
      assert.equal(item.onHand, fixture.onHand, `${fixture.product.name} total on-hand quantity`);
      assert.equal(
        item.stockValueZmw,
        formatCents(accountBalanceByProduct.get(fixture.product.id) ?? 0n),
        `${fixture.product.name} inventory-account balance`,
      );
      assert.equal(
        item.locations.reduce((total: bigint, location: { stockValueZmw: string }) => total + cents(location.stockValueZmw), 0n),
        accountBalanceByProduct.get(fixture.product.id) ?? 0n,
        `${fixture.product.name} location values must reconcile to inventory`,
      );
      for (const [locationId, quantity] of fixture.quantities) {
        const location = item.locations.find((row: { id: number | null }) => row.id === locationId);
        assert.ok(location, `${fixture.product.name} must include location ${locationId ?? "Unassigned"}`);
        assert.equal(location.onHand, quantity, `${fixture.product.name} on-hand at location ${locationId ?? "Unassigned"}`);
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (entryIds.length) {
      await db.delete(journalLines).where(inArray(journalLines.journalEntryId, entryIds));
      await db.delete(journalEntries).where(inArray(journalEntries.id, entryIds));
    }
    if (movementIds.length) await db.delete(inventoryMovements).where(inArray(inventoryMovements.id, movementIds));
    if (productIds.length) await db.delete(products).where(inArray(products.id, productIds));
    if (locationIds.length) await db.delete(inventoryLocations).where(inArray(inventoryLocations.id, locationIds));
    await pool.end();
  }
});
