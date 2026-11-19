import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import test from "node:test";
import {
  inventoryLocations, inventoryMovements, inventoryReservations, journalEntries, journalLines, products,
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
    const [emptyLocation] = await db.insert(inventoryLocations).values([
      { name: `Location reconciliation empty ${suffix}` },
    ]).returning();
    locationIds.push(emptyLocation.id);

    const productsForTest = await db.insert(products).values([
      { sku: `LOC-1-${suffix}`, name: `Location reconciliation product one ${suffix}`, status: "active" },
      { sku: `LOC-2-${suffix}`, name: `Location reconciliation product two ${suffix}`, status: "active" },
      { sku: `LOC-3-${suffix}`, name: `Location reconciliation zero-stock debit ${suffix}`, status: "active" },
      { sku: `LOC-4-${suffix}`, name: `Location reconciliation zero-stock credit ${suffix}`, status: "active" },
    ]).returning();
    productIds.push(...productsForTest.map(({ id }) => id));
    const [firstProduct, secondProduct, zeroStockDebitProduct, zeroStockCreditProduct] = productsForTest;
    assert.ok(firstProduct && secondProduct && zeroStockDebitProduct && zeroStockCreditProduct);

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
    await db.insert(inventoryReservations).values([
      { productId: firstProduct.id, locationId: locationA.id, quantity: 1, reason: "Location total regression fixture" },
      { productId: secondProduct.id, locationId: locationA.id, quantity: 1, reason: "Location total regression fixture" },
      { productId: firstProduct.id, locationId: locationB.id, quantity: 1, reason: "Location total regression fixture" },
      { productId: secondProduct.id, locationId: null, quantity: 1, reason: "Location total regression fixture" },
    ]);

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
      for (const { productId, amount, label, debit } of [
        { productId: zeroStockDebitProduct.id, amount: "0.07", label: "zero-stock-debit", debit: true },
        { productId: zeroStockCreditProduct.id, amount: "0.03", label: "zero-stock-credit", debit: false },
      ]) {
        const entry = await postJournal(tx, {
          sourceKey: `location-value-journal-${suffix}-${label}`,
          sourceType: "inventory_location_regression",
          sourceId: productId,
          memo: "Zero-stock inventory value regression fixture",
          lines: debit ? [
            { accountKey: "inventory", productId, debitZmw: amount, description: "Residual inventory debit" },
            { accountKey: "opening_balance_equity", creditZmw: amount, description: "Fixture opening equity" },
          ] : [
            { accountKey: "opening_balance_equity", debitZmw: amount, description: "Fixture opening equity" },
            { accountKey: "inventory", productId, creditZmw: amount, description: "Residual inventory credit" },
          ],
        });
        entryIds.push(entry.id);
      }
      return accountMap.get("inventory")!;
    });
    assert.ok(inventoryAccount);

    const response = await fetch(`${baseUrl}/api/inventory`);
    const payload = await response.json() as { inventory: any[]; locationTotals: any[] };
    assert.equal(response.status, 200, JSON.stringify(payload));
    const inventoryByProduct = new Map(
      payload.inventory.filter((item) => productIds.includes(item.id)).map((item) => [item.id, item]),
    );
    assert.equal(inventoryByProduct.size, productsForTest.length);
    const totalsByLocation = new Map(payload.locationTotals.map((total) => [total.id, total]));
    assert.deepEqual(
      [totalsByLocation.get(locationA.id)?.onHand, totalsByLocation.get(locationA.id)?.reserved, totalsByLocation.get(locationA.id)?.available],
      [3, 2, 1],
    );
    assert.deepEqual(
      [totalsByLocation.get(locationB.id)?.onHand, totalsByLocation.get(locationB.id)?.reserved, totalsByLocation.get(locationB.id)?.available],
      [3, 1, 2],
    );
    assert.deepEqual(
      [totalsByLocation.get(inactiveLocation.id)?.onHand, totalsByLocation.get(inactiveLocation.id)?.reserved, totalsByLocation.get(inactiveLocation.id)?.available],
      [1, 0, 1],
    );
    assert.deepEqual(
      [totalsByLocation.get(null)?.onHand, totalsByLocation.get(null)?.reserved, totalsByLocation.get(null)?.available],
      [3, 1, 2],
    );
    assert.deepEqual(
      [totalsByLocation.get(emptyLocation.id)?.onHand, totalsByLocation.get(emptyLocation.id)?.reserved, totalsByLocation.get(emptyLocation.id)?.available],
      [0, 0, 0],
    );
    assert.equal(totalsByLocation.get(emptyLocation.id)?.stockValueZmw, "0.00");

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
      { product: zeroStockDebitProduct, onHand: 0, quantities: [] as const, residualValue: "0.07" },
      { product: zeroStockCreditProduct, onHand: 0, quantities: [] as const, residualValue: "-0.03" },
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
      if ("residualValue" in fixture) {
        assert.ok(item.locations.every((location: { onHand: number }) => location.onHand === 0));
        assert.deepEqual(
          item.locations
            .filter((location: { stockValueZmw: string }) => cents(location.stockValueZmw) !== 0n)
            .map((location: { id: number | null; onHand: number; stockValueZmw: string }) => [
            location.id, location.onHand, location.stockValueZmw,
            ]),
          [[null, 0, fixture.residualValue]],
          `${fixture.product.name} must expose its complete residual balance once at Unassigned`,
        );
      }
    }

    const eventRequests = await Promise.all(["stock_return", "stock_damage"].map((kind) => fetch(`${baseUrl}/api/inventory/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind, productId: firstProduct.id, locationId: inactiveLocation.id,
        quantity: 1, reason: "Inactive location route regression", reference: null,
      }),
    })));
    for (const response of eventRequests) {
      const payload = await response.json() as { error?: string };
      assert.equal(response.status, 400, JSON.stringify(payload));
      assert.match(payload.error ?? "", /active stock location/i);
    }

    const transferRequests = await Promise.all([
      fetch(`${baseUrl}/api/inventory/transfers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId: firstProduct.id, fromLocationId: inactiveLocation.id, toLocationId: locationA.id,
          quantity: 1, reason: "Inactive source route regression", reference: null,
        }),
      }),
      fetch(`${baseUrl}/api/inventory/transfers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId: firstProduct.id, fromLocationId: locationA.id, toLocationId: inactiveLocation.id,
          quantity: 1, reason: "Inactive destination route regression", reference: null,
        }),
      }),
    ]);
    for (const response of transferRequests) {
      const payload = await response.json() as { error?: string };
      assert.equal(response.status, 400, JSON.stringify(payload));
      assert.match(payload.error ?? "", /active stock locations/i);
    }

    const [historyResponse, inventoryAfterRejectedWrites] = await Promise.all([
      fetch(`${baseUrl}/api/inventory/movements`),
      fetch(`${baseUrl}/api/inventory`),
    ]);
    const historyPayload = await historyResponse.json() as { movements: any[] };
    const inventoryAfterPayload = await inventoryAfterRejectedWrites.json() as { inventory: any[] };
    assert.equal(historyResponse.status, 200);
    assert.equal(inventoryAfterRejectedWrites.status, 200);
    assert.ok(historyPayload.movements.some((movement) =>
      movement.productId === firstProduct.id
      && movement.locationId === inactiveLocation.id
      && movement.kind === "opening_stock"
      && movement.quantityDelta === 1,
    ), "historical movement at an inactive location remains readable");
    const productAfterRejectedWrites = inventoryAfterPayload.inventory.find((item) => item.id === firstProduct.id);
    assert.ok(productAfterRejectedWrites);
    const inactiveBalanceAfterRejectedWrites = productAfterRejectedWrites.locations.find(
      (location: { id: number | null }) => location.id === inactiveLocation.id,
    );
    assert.deepEqual(
      [inactiveBalanceAfterRejectedWrites?.onHand, inactiveBalanceAfterRejectedWrites?.reserved],
      [1, 0],
      "historical balance at an inactive location remains readable and unchanged",
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (entryIds.length) {
      await db.delete(journalLines).where(inArray(journalLines.journalEntryId, entryIds));
      await db.delete(journalEntries).where(inArray(journalEntries.id, entryIds));
    }
    await db.delete(inventoryReservations).where(inArray(inventoryReservations.productId, productIds));
    if (movementIds.length) await db.delete(inventoryMovements).where(inArray(inventoryMovements.id, movementIds));
    if (productIds.length) await db.delete(products).where(inArray(products.id, productIds));
    if (locationIds.length) await db.delete(inventoryLocations).where(inArray(inventoryLocations.id, locationIds));
    await pool.end();
  }
});
