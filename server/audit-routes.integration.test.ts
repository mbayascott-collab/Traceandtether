import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { and, eq, isNull, like } from "drizzle-orm";
import test from "node:test";
import {
  businessAuditLogs, businessExpenses, businessPayments, customers, inventoryLocations, inventoryMovements,
  journalEntries, journalLines, marketingCampaigns, marketingCustomerGroups, paymentStatementLines,
  purchaseOrderLines, purchaseOrders, salesOrderLines, salesOrders,
} from "../shared/schema";

test("route mutations across business areas keep their audit history and actor", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [
    { db, pool },
    { registerApiRoutes },
    { postJournal },
  ] = await Promise.all([
    import("./db"),
    import("./routes"),
    import("./accounting-posting"),
  ]);

  const auditTable = await pool.query(
    "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
  );
  if (!auditTable.rows[0]?.exists) {
    t.skip("requires the business audit database migration");
    await pool.end();
    return;
  }
  const publicShopTables = await pool.query(
    "SELECT to_regclass('public.public_shop_challenges') IS NOT NULL AS exists",
  );
  const publicShopAvailable = Boolean(publicShopTables.rows[0]?.exists);
  const requiredColumns = new Set([
    "business_audit_logs.actor_clerk_user_id",
    "business_audit_logs.actor_email",
    "suppliers.payment_term_days",
    "public_shop_order_limits.ip_hash",
    "public_shop_order_attempt_counts.accepted_count",
    "marketing_customer_groups.rules",
    "accounting_accounts.system_key",
  ]);
  const availableColumns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (table_name, column_name) IN (
         ('business_audit_logs', 'actor_clerk_user_id'),
         ('business_audit_logs', 'actor_email'),
         ('suppliers', 'payment_term_days'),
         ('public_shop_order_limits', 'ip_hash'),
         ('public_shop_order_attempt_counts', 'accepted_count'),
         ('marketing_customer_groups', 'rules'),
         ('accounting_accounts', 'system_key')
       )`,
  );
  for (const column of availableColumns.rows) {
    requiredColumns.delete(`${column.table_name}.${column.column_name}`);
  }
  if (requiredColumns.size > 0) {
    t.skip("requires the current audit, accounting, and public shop database migrations");
    await pool.end();
    return;
  }

  const suffix = randomUUID();
  const safeSuffix = suffix.replaceAll("-", "");
  const actorId = `audit-route-test-${suffix}`;
  const actorEmail = `audit-route-test-${suffix}@example.test`;
  const clientIp = `198.51.100.${Number.parseInt(safeSuffix.slice(0, 2), 16) % 254 + 1}`;
  const clientIpHash = createHash("sha256").update(clientIp).digest("hex");
  const publicCustomerName = `Public audit customer ${suffix}`;
  const rollbackDescription = `Audit rollback ${suffix}`;
  const rollbackNote = `audit-rollback-${safeSuffix}`;
  const triggerName = `audit_rollback_${safeSuffix}`;
  const functionName = `${triggerName}_fn`;

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: actorId, email: actorEmail, role: "owner" };
    next();
  };
  registerApiRoutes(app, owner);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "x-forwarded-for": clientIp,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload: any = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    return { response, payload };
  };
  const expectStatus = async (path: string, body: unknown, method: string, status: number) => {
    const result = await request(path, body, method);
    assert.equal(result.response.status, status, JSON.stringify(result.payload));
    return result.payload;
  };
  const expectAudit = async (
    entityType: string,
    entityId: number,
    action: "created" | "updated" | "deleted",
    expectedActorId: string | null = actorId,
    expectedEmail = actorEmail,
    expectedChangedFields?: string[],
  ) => {
    const [entry] = await db.select().from(businessAuditLogs).where(and(
      eq(businessAuditLogs.entityType, entityType),
      eq(businessAuditLogs.entityId, entityId),
      eq(businessAuditLogs.action, action),
      expectedActorId === null
        ? isNull(businessAuditLogs.actorClerkUserId)
        : eq(businessAuditLogs.actorClerkUserId, expectedActorId),
      eq(businessAuditLogs.actorEmail, expectedEmail),
    )).limit(1);
    assert.ok(entry, `missing ${action} audit record for ${entityType} #${entityId}`);
    if (expectedChangedFields) {
      assert.deepEqual(entry.changedFields, expectedChangedFields);
    }
    return entry;
  };

  let productId: number | undefined;
  let supplierId: number | undefined;
  let customerId: number | undefined;
  let locationId: number | undefined;
  let salesOrderId: number | undefined;
  let purchaseOrderId: number | undefined;
  let customerGroupId: number | undefined;
  let marketingCampaignId: number | undefined;
  let statementLineId: number | undefined;
  let paymentTestSalesOrderId: number | undefined;
  let paymentTestPurchaseOrderId: number | undefined;
  let paymentTestPayableJournalKey: string | undefined;
  let publicOrderNumber: string | undefined;
  let publicCustomerId: number | undefined;
  let publicOrderAccepted = false;
  let functionCreated = false;
  let triggerCreated = false;

  try {
    const productBody = {
      sku: `AUD-${safeSuffix}`,
      name: `Audit route product ${suffix}`,
      description: null,
      imageUrl: null,
      brand: `Audit brand ${suffix}`,
      categoryId: null,
      supplierName: null,
      supplierProductCode: null,
      purchaseCurrency: "CNY",
      purchasePrice: "10.00",
      estimatedLandedCostZmw: "25.00",
      sellingPriceZmw: "50.00",
      reorderThreshold: 0,
      unit: "piece",
      status: "active" as const,
    };
    const createdProduct = await expectStatus("/api/products", productBody, "POST", 201);
    const createdProductId = createdProduct.product.id as number;
    productId = createdProductId;
    const productCreateFields = [
      "sku", "name", "description", "imageUrl", "brand", "categoryId", "supplierName",
      "supplierProductCode", "purchaseCurrency", "purchasePrice", "estimatedLandedCostZmw",
      "sellingPriceZmw", "reorderThreshold", "unit", "status",
    ];
    await expectAudit("product", createdProductId, "created", actorId, actorEmail, productCreateFields);
    const updatedProductBody = {
      ...productBody,
      name: `Updated audit route product ${suffix}`,
      brand: `Updated audit brand ${suffix}`,
    };
    const updatedProduct = await expectStatus(
      `/api/products/${createdProductId}`, updatedProductBody, "PUT", 200,
    );
    assert.equal(updatedProduct.product.name, updatedProductBody.name);
    await expectAudit("product", createdProductId, "updated", actorId, actorEmail, ["name", "brand"]);

    const supplierBody = {
      name: `Audit route supplier ${suffix}`,
      country: "China",
      contactName: `Contact ${suffix}`,
      email: null,
      phone: null,
      website: null,
      paymentTerms: null,
      paymentTermDays: null,
      defaultLeadTimeDays: 0,
      notes: null,
      status: "active" as const,
    };
    const createdSupplier = await expectStatus("/api/suppliers", supplierBody, "POST", 201);
    const createdSupplierId = createdSupplier.supplier.id as number;
    supplierId = createdSupplierId;
    const supplierCreateFields = [
      "name", "country", "contactName", "email", "phone", "website", "paymentTerms",
      "paymentTermDays", "defaultLeadTimeDays", "notes", "status",
    ];
    await expectAudit("supplier", createdSupplierId, "created", actorId, actorEmail, supplierCreateFields);
    const updatedSupplierBody = {
      ...supplierBody,
      name: `Updated audit route supplier ${suffix}`,
      notes: `Updated supplier notes ${suffix}`,
    };
    const updatedSupplier = await expectStatus(
      `/api/suppliers/${createdSupplierId}`, updatedSupplierBody, "PATCH", 200,
    );
    assert.equal(updatedSupplier.supplier.name, updatedSupplierBody.name);
    await expectAudit("supplier", createdSupplierId, "updated", actorId, actorEmail, ["name", "notes"]);
    const [customer] = await db.insert(customers).values({
      name: `Audit route customer ${suffix}`,
    }).returning();
    customerId = customer.id;
    const [location] = await db.insert(inventoryLocations).values({
      name: `Audit route location ${suffix}`,
    }).returning();
    locationId = location.id;
    await db.insert(inventoryMovements).values({
      productId,
      locationId,
      kind: "opening_stock",
      quantityDelta: 10,
      reason: `Audit route test stock ${suffix}`,
      sourceKey: `audit-route-seed-${suffix}`,
    });

    // Sales: create and delete a draft order through the HTTP routes.
    const sales = await expectStatus("/api/sales-orders", {
      customerId,
      deliveryAddress: null,
      notes: null,
      lines: [{ productId, quantity: 1, unitPriceZmw: "50.00" }],
    }, "POST", 201);
    salesOrderId = sales.order.id;
    const createdSalesOrderId = sales.order.id as number;
    await expectAudit("sales_order", createdSalesOrderId, "created");
    await expectStatus(`/api/sales-orders/${createdSalesOrderId}`, undefined, "DELETE", 200);
    await expectAudit("sales_order", createdSalesOrderId, "deleted");

    // Inventory: post an adjustment through the route.
    const adjustment = await expectStatus("/api/inventory/adjustments", {
      productId, locationId, quantityDelta: 1, reason: `Audit route adjustment ${suffix}`,
    }, "POST", 201);
    await expectAudit("inventory_movement", adjustment.movement.id, "created");

    // Purchasing: create and update an order through the route.
    const purchase = await expectStatus("/api/purchase-orders", {
      supplierId,
      currency: "CNY",
      exchangeRateToZmw: "2",
      expectedAt: null,
      notes: `Audit route purchase ${suffix}`,
      lines: [{ productId, quantityOrdered: 2, unitPrice: "10.00" }],
    }, "POST", 201);
    purchaseOrderId = purchase.order.id;
    const createdPurchaseOrderId = purchase.order.id as number;
    await expectAudit("purchase_order", createdPurchaseOrderId, "created");
    await expectStatus(`/api/purchase-orders/${createdPurchaseOrderId}`, {
      status: "cancelled",
      expectedAt: null,
      notes: `Updated audit route purchase ${suffix}`,
    }, "PATCH", 200);
    await expectAudit("purchase_order", createdPurchaseOrderId, "updated");

    // Accounting: post a valid business expense.
    const expense = await expectStatus("/api/accounting/expenses", {
      category: "other",
      description: `Audit route expense ${suffix}`,
      amountZmw: "3.25",
      expenseDate: "2026-11-18",
      method: "cash",
      notes: "",
    }, "POST", 201);
    await expectAudit("business_expense", expense.expense.id, "created");

    // Payments: create a statement line and update its match state via routes.
    const accounts = await request("/api/payments/reconciliation/accounts");
    assert.equal(accounts.response.status, 200, JSON.stringify(accounts.payload));
    const cashAccount = accounts.payload.accounts.find(
      (account: { systemKey: string }) => account.systemKey === "cash_on_hand",
    );
    assert.ok(cashAccount, "cash reconciliation account is available");
    await expectStatus("/api/payments/reconciliation/lines", {
      accountId: cashAccount.id,
      from: "2026-11-18",
      to: "2026-11-18",
      lines: [{
        transactionDate: "2026-11-18",
        flow: "in",
        amountZmw: "1.00",
        description: `Audit route statement ${suffix}`,
      }],
    }, "POST", 201);
    const [statementLine] = await db.select().from(paymentStatementLines)
      .where(eq(paymentStatementLines.description, `Audit route statement ${suffix}`));
    assert.ok(statementLine);
    statementLineId = statementLine.id;
    await expectAudit("payment_statement_line", statementLineId, "created");
    await expectStatus("/api/payments/reconciliation/match", {
      lineId: statementLineId, paymentId: null,
    }, "PUT", 200);
    await expectAudit("payment_statement_line", statementLineId, "updated");

    // Marketing: create, update, and delete a customer group via HTTP.
    const groupBody = {
      name: `Audit route group ${suffix}`,
      rules: { minimumFulfilledOrders: 1 },
    };
    const group = await expectStatus("/api/marketing/customer-groups", groupBody, "POST", 201);
    customerGroupId = group.group.id;
    const createdCustomerGroupId = group.group.id as number;
    await expectAudit("marketing_customer_group", createdCustomerGroupId, "created");
    await expectStatus(`/api/marketing/customer-groups/${customerGroupId}`, {
      ...groupBody, name: `Updated audit route group ${suffix}`,
    }, "PATCH", 200);
    await expectAudit("marketing_customer_group", createdCustomerGroupId, "updated");
    const [linkedCampaign] = await db.insert(marketingCampaigns).values({
      name: `Audit route linked campaign ${suffix}`,
      status: "draft",
      customerGroupId: createdCustomerGroupId,
    }).returning();
    marketingCampaignId = linkedCampaign.id;
    const deletionImpact = await expectStatus(
      `/api/marketing/customer-groups/${createdCustomerGroupId}/deletion-impact`,
      undefined,
      "GET",
      200,
    );
    assert.deepEqual(deletionImpact.campaigns.map((campaign: { id: number }) => campaign.id), [linkedCampaign.id]);
    const stillLinked = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, linkedCampaign.id));
    assert.equal(stillLinked[0]?.customerGroupId, createdCustomerGroupId);
    const staleDelete = await request(`/api/marketing/customer-groups/${createdCustomerGroupId}`, {
      campaignIds: [],
    }, "DELETE");
    assert.equal(staleDelete.response.status, 409, JSON.stringify(staleDelete.payload));
    const afterStaleDelete = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, linkedCampaign.id));
    assert.equal(afterStaleDelete[0]?.customerGroupId, createdCustomerGroupId);
    await expectStatus(`/api/marketing/customer-groups/${createdCustomerGroupId}`, {
      campaignIds: [linkedCampaign.id],
    }, "DELETE", 204);
    const afterDelete = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, linkedCampaign.id));
    assert.equal(afterDelete[0]?.customerGroupId, null);
    await expectAudit("marketing_campaign", linkedCampaign.id, "updated");
    await expectAudit("marketing_customer_group", createdCustomerGroupId, "deleted");

    // Public shop: attribute its customer and order to the unauthenticated actor.
    if (publicShopAvailable) {
      const shop = await request("/api/shop/products");
      assert.equal(shop.response.status, 200, JSON.stringify(shop.payload));
      assert.ok(shop.payload.products.some((item: { id: number }) => item.id === productId));
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      const publicOrder = await expectStatus("/api/shop/orders", {
        name: publicCustomerName,
        phone: "+260 977 000 001",
        email: "",
        address: "",
        notes: "",
        lines: [{ productId, quantity: 1 }],
        challenge: shop.payload.challenge,
        website: "",
      }, "POST", 201);
      publicOrderNumber = publicOrder.orderNumber;
      publicOrderAccepted = true;
      const [publicCustomer] = await db.select().from(customers)
        .where(eq(customers.name, publicCustomerName));
      assert.ok(publicCustomer);
      publicCustomerId = publicCustomer.id;
      const [publicSalesOrder] = await db.select().from(salesOrders)
        .where(eq(salesOrders.orderNumber, publicOrderNumber!));
      assert.ok(publicSalesOrder);
      await expectAudit("customer", publicCustomerId, "created", null, "Public shop");
      await expectAudit("sales_order", publicSalesOrder.id, "created", null, "Public shop");
    }

    // Seed valid customer and supplier balances before installing the failing
    // journal trigger used to verify payment transaction rollback.
    const paymentSalesOrderNumber = `AUD-PAY-C-${safeSuffix.slice(0, 12)}`;
    const [paymentSalesOrder] = await db.insert(salesOrders).values({
      orderNumber: paymentSalesOrderNumber,
      customerId: customerId!,
      status: "fulfilled",
      orderDate: "2026-11-18",
    }).returning();
    paymentTestSalesOrderId = paymentSalesOrder.id;
    await db.insert(salesOrderLines).values({
      salesOrderId: paymentSalesOrder.id,
      productId: productId!,
      quantity: 1,
      unitPriceZmw: "50.00",
    });

    const paymentPurchaseOrderNumber = `AUD-PAY-S-${safeSuffix.slice(0, 12)}`;
    const [paymentPurchaseOrder] = await db.insert(purchaseOrders).values({
      orderNumber: paymentPurchaseOrderNumber,
      supplierId: supplierId!,
      currency: "ZMW",
      exchangeRateToZmw: "1",
      orderedAt: "2026-11-18",
    }).returning();
    paymentTestPurchaseOrderId = paymentPurchaseOrder.id;
    await db.insert(purchaseOrderLines).values({
      purchaseOrderId: paymentPurchaseOrder.id,
      productId: productId!,
      quantityOrdered: 1,
      unitPrice: "50.00",
    });
    paymentTestPayableJournalKey = `audit-route-payable-${suffix}`;
    await db.transaction((tx) => postJournal(tx, {
      sourceKey: paymentTestPayableJournalKey!,
      sourceType: "stock_receipt",
      sourceId: paymentPurchaseOrder.id,
      memo: `Stock receipt for ${paymentPurchaseOrderNumber}`,
      entryDate: "2026-11-18",
      lines: [
        { accountKey: "inventory", productId: productId!, debitZmw: "50.00" },
        { accountKey: "accounts_payable", creditZmw: "50.00" },
      ],
    }));

    // Fail after the accounting route writes its audit row. The transaction must roll both back.
    await pool.query(`
      CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        entry_source_type text;
        entry_source_id integer;
      BEGIN
        IF NEW.description = '${rollbackNote}' THEN
          RAISE EXCEPTION 'forced audit route rollback';
        END IF;
        SELECT source_type, source_id INTO entry_source_type, entry_source_id
        FROM journal_entries WHERE id = NEW.journal_entry_id;
        IF entry_source_type = 'payment' AND EXISTS (
          SELECT 1 FROM business_audit_logs
          WHERE entity_type = 'payment'
            AND entity_id = entry_source_id
            AND actor_clerk_user_id = '${actorId}'
        ) THEN
          RAISE EXCEPTION 'forced payment posting rollback: journal %, payment %',
            NEW.journal_entry_id, entry_source_id;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    functionCreated = true;
    await pool.query(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON journal_lines
      FOR EACH ROW EXECUTE FUNCTION public.${functionName}()
    `);
    triggerCreated = true;
    const failed = await request("/api/accounting/expenses", {
      category: "other",
      description: rollbackDescription,
      amountZmw: "4.00",
      expenseDate: "2026-11-18",
      method: "cash",
      notes: rollbackNote,
    });
    assert.equal(failed.response.status, 500, JSON.stringify(failed.payload));
    const failedExpense = await db.select().from(businessExpenses)
      .where(eq(businessExpenses.description, rollbackDescription));
    assert.equal(failedExpense.length, 0);
    const failedAudit = await db.select().from(businessAuditLogs).where(and(
      eq(businessAuditLogs.entityType, "business_expense"),
      eq(businessAuditLogs.actorClerkUserId, actorId),
      eq(businessAuditLogs.recordLabel, `other: ${rollbackDescription}`),
    ));
    assert.equal(failedAudit.length, 0, "failed accounting transaction leaves no audit entry");

    // Both payment directions must roll back the inserted payment and its
    // audit entry when journal posting fails after the audit row is present.
    for (const paymentCase of [
      {
        direction: "customer_receipt",
        orderId: paymentTestSalesOrderId,
        orderNumber: paymentSalesOrderNumber,
        reference: `Audit route failed customer receipt ${suffix}`,
      },
      {
        direction: "supplier_payment",
        orderId: paymentTestPurchaseOrderId,
        orderNumber: paymentPurchaseOrderNumber,
        reference: `Audit route failed supplier payment ${suffix}`,
      },
    ]) {
      const idempotencyKey = randomUUID();
      const failedPayment = await request("/api/payments", {
        direction: paymentCase.direction,
        idempotencyKey,
        orderId: paymentCase.orderId,
        amountZmw: "1.00",
        paymentDate: "2026-11-18",
        method: "cash",
        reference: paymentCase.reference,
        notes: null,
      });
      assert.equal(failedPayment.response.status, 500, JSON.stringify(failedPayment.payload));
      assert.match(
        String(failedPayment.payload.error ?? ""),
        /insert into "journal_lines"/,
        "payment reached journal posting after its audit row was inserted",
      );

      const savedPayment = await db.select().from(businessPayments)
        .where(eq(businessPayments.idempotencyKey, idempotencyKey));
      assert.equal(savedPayment.length, 0, `${paymentCase.direction} must roll back`);
      const savedJournal = await db.select().from(journalEntries)
        .where(and(
          eq(journalEntries.sourceType, "payment"),
          like(journalEntries.memo, `%for ${paymentCase.orderNumber}`),
        ));
      assert.equal(savedJournal.length, 0, `${paymentCase.direction} journal entry must roll back`);
      const savedJournalLines = await db.select({ id: journalLines.id })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
        .where(and(
          eq(journalEntries.sourceType, "payment"),
          like(journalEntries.memo, `%for ${paymentCase.orderNumber}`),
        ));
      assert.equal(savedJournalLines.length, 0, `${paymentCase.direction} journal lines must roll back`);
      const savedAudit = await db.select().from(businessAuditLogs).where(and(
        eq(businessAuditLogs.entityType, "payment"),
        eq(businessAuditLogs.actorClerkUserId, actorId),
      ));
      assert.equal(savedAudit.length, 0, `${paymentCase.direction} audit entry must roll back`);
    }
  } finally {
    if (triggerCreated) await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON journal_lines`);
    if (functionCreated) await pool.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_clerk_user_id = $1", [actorId]);
      if (publicCustomerId) {
        await client.query(
          "DELETE FROM business_audit_logs WHERE entity_type = 'customer' AND entity_id = $1",
          [publicCustomerId],
        );
      } else {
        await client.query(
          "DELETE FROM business_audit_logs WHERE entity_type = 'customer' AND entity_id IN (SELECT id FROM customers WHERE name = $1)",
          [publicCustomerName],
        );
      }
      if (publicOrderNumber) {
        await client.query(
          "DELETE FROM business_audit_logs WHERE entity_type = 'sales_order' AND entity_id IN (SELECT id FROM sales_orders WHERE order_number = $1)",
          [publicOrderNumber],
        );
        await client.query(
          "DELETE FROM sales_order_lines WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE order_number = $1)",
          [publicOrderNumber],
        );
        await client.query(`
          WITH removed_orders AS (
            DELETE FROM sales_orders WHERE order_number = $1 RETURNING customer_id
          )
          DELETE FROM customers WHERE id IN (SELECT customer_id FROM removed_orders)
        `, [publicOrderNumber]);
      }
      if (statementLineId) await client.query(
        "DELETE FROM payment_statement_lines WHERE id = $1", [statementLineId],
      );
      if (paymentTestSalesOrderId) {
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [paymentTestSalesOrderId]);
        await client.query("DELETE FROM sales_orders WHERE id = $1", [paymentTestSalesOrderId]);
      }
      if (paymentTestPurchaseOrderId) {
        await client.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1", [paymentTestPurchaseOrderId]);
        if (paymentTestPayableJournalKey) {
          await client.query(`
            DELETE FROM journal_lines
            WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE source_key = $1)
          `, [paymentTestPayableJournalKey]);
          await client.query("DELETE FROM journal_entries WHERE source_key = $1", [paymentTestPayableJournalKey]);
        }
        await client.query("DELETE FROM purchase_orders WHERE id = $1", [paymentTestPurchaseOrderId]);
      }
      if (customerGroupId) await client.query(
        "DELETE FROM marketing_customer_groups WHERE id = $1", [customerGroupId],
      );
      if (marketingCampaignId) await client.query(
        "DELETE FROM marketing_campaigns WHERE id = $1", [marketingCampaignId],
      );
      if (purchaseOrderId) {
        await client.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1", [purchaseOrderId]);
        await client.query("DELETE FROM purchase_orders WHERE id = $1", [purchaseOrderId]);
      }
      if (productId) {
        await client.query(`
          DELETE FROM journal_lines
          WHERE journal_entry_id IN (
            SELECT id FROM journal_entries
            WHERE source_type = 'business_expense'
              AND source_id IN (SELECT id FROM business_expenses WHERE description = $1)
          )
        `, [`Audit route expense ${suffix}`]);
        await client.query(`
          DELETE FROM journal_entries
          WHERE source_type = 'business_expense'
            AND source_id IN (SELECT id FROM business_expenses WHERE description = $1)
        `, [`Audit route expense ${suffix}`]);
        await client.query("DELETE FROM business_expenses WHERE description = $1", [`Audit route expense ${suffix}`]);
        await client.query("DELETE FROM journal_lines WHERE product_id = $1", [productId]);
        await client.query("DELETE FROM inventory_movements WHERE product_id = $1", [productId]);
      }
      if (salesOrderId) {
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [salesOrderId]);
        await client.query("DELETE FROM sales_orders WHERE id = $1", [salesOrderId]);
      }
      if (productId) await client.query("DELETE FROM products WHERE id = $1", [productId]);
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
      if (supplierId) await client.query("DELETE FROM suppliers WHERE id = $1", [supplierId]);
      if (locationId) await client.query("DELETE FROM inventory_locations WHERE id = $1", [locationId]);
      await client.query("DELETE FROM public_shop_order_limits WHERE ip_hash = $1", [clientIpHash]);
      if (publicOrderAccepted) {
        await client.query(`
          UPDATE public_shop_order_attempt_counts
          SET accepted_count = greatest(accepted_count - 1, 0)
          WHERE id = 1
        `);
      }
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
