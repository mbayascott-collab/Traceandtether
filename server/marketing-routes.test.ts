import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import test from "node:test";
import {
  accountingAccounts, businessAuditLogs, customers, journalEntries, journalLines, marketingAttributions,
  marketingCampaigns, marketingCustomerGroups, marketingExpenses, products, salesDeliveries, salesDeliveryLines,
  salesOrderLines, salesOrders,
} from "../shared/schema";

test("customer-group CSV downloads are limited to owners", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db }, { registerMarketingRoutes }, { createBusinessAccessMiddleware }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
    import("./access-control"),
  ]);
  const suffix = randomUUID();
  const customerName = `group-export-${suffix}`;
  const contactEmail = `group-export-${suffix}@example.test`;
  const contactPhone = `+260-${suffix.slice(0, 8)}`;
  const groupName = `Group export ${suffix}`;
  const app = express();
  const access = createBusinessAccessMiddleware(
    async (userId) => ({
      authorized: true as const,
      actor: {
        clerkUserId: userId,
        email: `${userId}@example.test`,
        role: userId === "test-manager" ? "manager" as const : "owner" as const,
      },
    }),
    (req) => req.header("x-test-user"),
  );
  registerMarketingRoutes(app, access);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let customerId: number | undefined;
  let groupId: number | undefined;

  try {
    const [customer] = await db.insert(customers).values({
      name: customerName, email: contactEmail, phone: contactPhone,
    }).returning();
    customerId = customer.id;
    const [group] = await db.insert(marketingCustomerGroups).values({
      name: groupName, rules: {},
    }).returning();
    groupId = group.id;

    const download = async (userId?: string) => {
      const response = await fetch(`${baseUrl}/api/marketing/customer-groups/${group.id}/export.csv`, {
        headers: userId ? { "x-test-user": userId } : undefined,
      });
      return { response, body: await response.text() };
    };

    const ownerDownload = await download("test-owner");
    assert.equal(ownerDownload.response.status, 200, ownerDownload.body);
    assert.match(ownerDownload.response.headers.get("content-type") ?? "", /text\/csv/i);
    assert.ok(ownerDownload.body.includes(customerName));
    assert.ok(ownerDownload.body.includes(contactEmail));
    assert.ok(ownerDownload.body.includes(contactPhone));

    const managerDownload = await download("test-manager");
    assert.equal(managerDownload.response.status, 403);
    assert.match(managerDownload.body, /Only the business owner/i);
    assert.ok(!managerDownload.body.includes(customerName));
    assert.ok(!managerDownload.body.includes(contactEmail));
    assert.ok(!managerDownload.body.includes(contactPhone));

    const signedOutDownload = await download();
    assert.equal(signedOutDownload.response.status, 401);
    assert.match(signedOutDownload.body, /Sign in/i);
    assert.ok(!signedOutDownload.body.includes(customerName));
    assert.ok(!signedOutDownload.body.includes(contactEmail));
    assert.ok(!signedOutDownload.body.includes(contactPhone));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (groupId) await db.delete(marketingCustomerGroups).where(eq(marketingCustomerGroups.id, groupId));
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  }
});

test("customer-group CSV exports reflect updated rules and customer order history", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db }, { registerMarketingRoutes }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
  ]);
  const suffix = randomUUID();
  const prefix = `group-freshness-${suffix}`;
  const actorEmail = `${prefix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerMarketingRoutes(app, owner);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const [firstName, firstEmail, firstPhone, secondName, secondEmail, secondPhone] = [
    `${prefix} first`, `${prefix}-first@example.test`, `+260-${suffix.slice(0, 8)}`,
    `${prefix} second`, `${prefix}-second@example.test`, `+260-${suffix.slice(8, 16)}`,
  ];
  let firstCustomerId: number | undefined;
  let secondCustomerId: number | undefined;
  let productId: number | undefined;
  let groupId: number | undefined;
  const orderIds: number[] = [];
  const orderLineIds: number[] = [];

  const download = async () => {
    const response = await fetch(`${baseUrl}/api/marketing/customer-groups/${groupId}/export.csv`);
    return { response, body: await response.text() };
  };
  const patchGroup = async (rules: Record<string, number | string>) => {
    const response = await fetch(`${baseUrl}/api/marketing/customer-groups/${groupId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `${prefix} group`, rules }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
  };
  const assertColumns = (body: string) => {
    assert.equal(body.split("\r\n", 1)[0], '"Name","Email","Phone"');
  };

  try {
    const [firstCustomer] = await db.insert(customers).values({
      name: firstName, email: firstEmail, phone: firstPhone,
    }).returning();
    firstCustomerId = firstCustomer.id;
    const [secondCustomer] = await db.insert(customers).values({
      name: secondName, email: secondEmail, phone: secondPhone,
    }).returning();
    secondCustomerId = secondCustomer.id;
    const [product] = await db.insert(products).values({
      sku: `GF-${suffix}`,
      name: `${prefix} product`,
      sellingPriceZmw: "100.00",
      status: "active",
    }).returning();
    productId = product.id;
    const [group] = await db.insert(marketingCustomerGroups).values({
      name: `${prefix} group`,
      rules: { minimumFulfilledOrders: 2 },
    }).returning();
    groupId = group.id;

    const [firstOrder] = await db.insert(salesOrders).values({
      orderNumber: `GF-${suffix.slice(0, 20)}-1`,
      customerId: firstCustomer.id,
      status: "fulfilled",
      orderDate: "2026-11-01",
    }).returning();
    orderIds.push(firstOrder.id);
    const [secondOrder] = await db.insert(salesOrders).values({
      orderNumber: `GF-${suffix.slice(0, 20)}-2`,
      customerId: secondCustomer.id,
      status: "confirmed",
      orderDate: "2026-11-02",
    }).returning();
    orderIds.push(secondOrder.id);
    const orderLines = await db.insert(salesOrderLines).values([
      { salesOrderId: firstOrder.id, productId: product.id, quantity: 1, unitPriceZmw: "100.00" },
      { salesOrderId: secondOrder.id, productId: product.id, quantity: 1, unitPriceZmw: "100.00" },
    ]).returning();
    orderLineIds.push(...orderLines.map((line) => line.id));

    const beforeRuleChange = await download();
    assert.equal(beforeRuleChange.response.status, 200, beforeRuleChange.body);
    assertColumns(beforeRuleChange.body);
    assert.ok(!beforeRuleChange.body.includes(firstEmail));
    assert.ok(!beforeRuleChange.body.includes(secondEmail));

    await patchGroup({ minimumFulfilledOrders: 1 });
    const afterRuleChange = await download();
    assert.equal(afterRuleChange.response.status, 200, afterRuleChange.body);
    assertColumns(afterRuleChange.body);
    assert.ok(afterRuleChange.body.includes(firstEmail));
    assert.ok(afterRuleChange.body.includes(firstName));
    assert.ok(afterRuleChange.body.includes(firstPhone));
    assert.ok(!afterRuleChange.body.includes(secondEmail));

    await Promise.all([
      db.update(salesOrders).set({ status: "confirmed" }).where(eq(salesOrders.id, firstOrder.id)),
      db.update(salesOrders).set({ status: "fulfilled" }).where(eq(salesOrders.id, secondOrder.id)),
    ]);
    const afterHistoryChange = await download();
    assert.equal(afterHistoryChange.response.status, 200, afterHistoryChange.body);
    assertColumns(afterHistoryChange.body);
    assert.ok(!afterHistoryChange.body.includes(firstEmail));
    assert.ok(afterHistoryChange.body.includes(secondEmail));
    assert.ok(afterHistoryChange.body.includes(secondName));
    assert.ok(afterHistoryChange.body.includes(secondPhone));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (orderLineIds.length) await db.delete(salesOrderLines).where(inArray(salesOrderLines.id, orderLineIds));
    if (orderIds.length) await db.delete(salesOrders).where(inArray(salesOrders.id, orderIds));
    if (groupId) await db.delete(marketingCustomerGroups).where(eq(marketingCustomerGroups.id, groupId));
    await db.delete(businessAuditLogs).where(eq(businessAuditLogs.actorEmail, actorEmail));
    if (productId) await db.delete(products).where(eq(products.id, productId));
    if (firstCustomerId) await db.delete(customers).where(eq(customers.id, firstCustomerId));
    if (secondCustomerId) await db.delete(customers).where(eq(customers.id, secondCustomerId));
  }
});

test("marketing report counts partial campaign deliveries once and matches posted costs and expenses", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerMarketingRoutes }, { postJournal }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
    import("./accounting-posting"),
  ]);
  const requiredColumns = new Set([
    "marketing_attributions.source",
    "business_audit_logs.actor_email",
  ]);
  const availableColumns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (table_name, column_name) IN (
         ('marketing_attributions', 'source'),
         ('business_audit_logs', 'actor_email')
       )`,
  );
  for (const column of availableColumns.rows) requiredColumns.delete(`${column.table_name}.${column.column_name}`);
  if (requiredColumns.size > 0) {
    await pool.end();
    t.skip("requires the campaign attribution and business audit migrations");
    return;
  }

  const suffix = randomUUID();
  const prefix = `marketing-report-${suffix}`;
  const orderPrefix = `MKT-${suffix.slice(0, 20)}`;
  const actorEmail = `${prefix}@example.test`;
  const reportDate = "2001-01-01";
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerMarketingRoutes(app, owner);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json() as any;
    return { response, payload };
  };

  try {
    const baseline = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(baseline.response.status, 200, JSON.stringify(baseline.payload));

    const [fullyCostedCampaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} fully costed`, status: "active",
    }).returning();
    const [missingCostCampaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} missing cost`, status: "active",
    }).returning();
    const [product] = await db.insert(products).values({
      sku: `MKT-${suffix}`,
      name: `${prefix} product`,
      sellingPriceZmw: "100.00",
      status: "active",
    }).returning();
    const [customer] = await db.insert(customers).values({
      name: `${prefix} customer`,
    }).returning();

    const [fullyCostedOrder] = await db.insert(salesOrders).values({
      orderNumber: `${orderPrefix}-FULL`,
      customerId: customer.id,
      status: "partially_fulfilled",
      orderDate: reportDate,
    }).returning();
    const [fullyCostedLine] = await db.insert(salesOrderLines).values({
      salesOrderId: fullyCostedOrder.id, productId: product.id, quantity: 4, unitPriceZmw: "100.00",
    }).returning();
    const [missingCostOrder] = await db.insert(salesOrders).values({
      orderNumber: `${orderPrefix}-MISSING`,
      customerId: customer.id,
      status: "fulfilled",
      orderDate: reportDate,
    }).returning();
    const [missingCostLine] = await db.insert(salesOrderLines).values({
      salesOrderId: missingCostOrder.id, productId: product.id, quantity: 2, unitPriceZmw: "50.00",
    }).returning();

    const deliveries = await Promise.all([
      db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-F1`, salesOrderId: fullyCostedOrder.id, deliveryDate: reportDate,
      }).returning(),
      db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-F2`, salesOrderId: fullyCostedOrder.id, deliveryDate: reportDate,
      }).returning(),
      db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-M1`, salesOrderId: missingCostOrder.id, deliveryDate: reportDate,
      }).returning(),
      db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-M2`, salesOrderId: missingCostOrder.id, deliveryDate: reportDate,
      }).returning(),
    ]);
    const [fullDeliveryOne, fullDeliveryTwo, missingDeliveryOne, missingDeliveryTwo] =
      deliveries.map(([delivery]) => delivery);
    await db.insert(salesDeliveryLines).values([
      { deliveryId: fullDeliveryOne.id, salesOrderLineId: fullyCostedLine.id, quantity: 1 },
      { deliveryId: fullDeliveryTwo.id, salesOrderLineId: fullyCostedLine.id, quantity: 2 },
      { deliveryId: missingDeliveryOne.id, salesOrderLineId: missingCostLine.id, quantity: 1 },
      { deliveryId: missingDeliveryTwo.id, salesOrderLineId: missingCostLine.id, quantity: 1 },
    ]);
    await db.insert(marketingAttributions).values([
      { salesOrderId: fullyCostedOrder.id, campaignId: fullyCostedCampaign.id, source: "manual" },
      { salesOrderId: missingCostOrder.id, campaignId: missingCostCampaign.id, source: "campaign_link" },
    ]);

    const postSaleEntry = async (
      deliveryId: number,
      kind: "revenue" | "cogs",
      amount: string,
    ) => db.transaction((tx) => postJournal(tx, {
      sourceKey: `${prefix}-${kind}-${deliveryId}`,
      sourceType: kind === "revenue" ? "sales_delivery" : "sales_delivery_cogs",
      sourceId: deliveryId,
      memo: `${prefix} ${kind} posting`,
      entryDate: reportDate,
      lines: kind === "revenue"
        ? [
          { accountKey: "accounts_receivable", debitZmw: amount },
          { accountKey: "sales_revenue", creditZmw: amount },
        ]
        : [
          { accountKey: "cost_of_goods_sold", productId: product.id, debitZmw: amount },
          { accountKey: "inventory", productId: product.id, creditZmw: amount },
        ],
    }));
    await Promise.all([
      postSaleEntry(fullDeliveryOne.id, "revenue", "100.00"),
      postSaleEntry(fullDeliveryTwo.id, "revenue", "200.00"),
      postSaleEntry(missingDeliveryOne.id, "revenue", "50.00"),
      postSaleEntry(missingDeliveryTwo.id, "revenue", "50.00"),
      postSaleEntry(fullDeliveryOne.id, "cogs", "30.00"),
      postSaleEntry(fullDeliveryTwo.id, "cogs", "60.00"),
      postSaleEntry(missingDeliveryOne.id, "cogs", "20.00"),
    ]);
    await db.transaction((tx) => postJournal(tx, {
      sourceKey: `${prefix}-late-adjustment`,
      sourceType: "landed_cost_adjustment",
      sourceId: product.id,
      memo: `${prefix} late landed-cost adjustment`,
      entryDate: reportDate,
      lines: [
        { accountKey: "cost_of_goods_sold", productId: product.id, debitZmw: "11.00" },
        { accountKey: "inventory", productId: product.id, creditZmw: "11.00" },
      ],
    }));

    const campaignExpense = await request("/api/marketing/expenses", {
      campaignId: fullyCostedCampaign.id,
      category: "Advertising",
      description: `${prefix} campaign advertisement`,
      amount: "1.01",
      currency: "USD",
      exchangeRateToZmw: "7.5",
      expenseDate: reportDate,
      paid: false,
      reference: null,
      notes: null,
    });
    assert.equal(campaignExpense.response.status, 201, JSON.stringify(campaignExpense.payload));
    assert.equal(campaignExpense.payload.amountZmw, "7.58");

    const generalExpense = await request("/api/marketing/expenses", {
      campaignId: null,
      category: "Advertising",
      description: `${prefix} general advertisement`,
      amount: "2.03",
      currency: "EUR",
      exchangeRateToZmw: "8.25",
      expenseDate: reportDate,
      paid: false,
      reference: null,
      notes: null,
    });
    assert.equal(generalExpense.response.status, 201, JSON.stringify(generalExpense.payload));
    assert.equal(generalExpense.payload.amountZmw, "16.75");

    const expenseIds = [campaignExpense.payload.expense.id, generalExpense.payload.expense.id] as number[];
    const postedExpenseLines = await db.select({
      sourceId: journalEntries.sourceId,
      systemKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalEntries)
      .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(accountingAccounts, eq(accountingAccounts.id, journalLines.accountId))
      .where(and(
        eq(journalEntries.sourceType, "marketing_expense"),
        inArray(journalEntries.sourceId, expenseIds),
      ));
    assert.deepEqual(
      postedExpenseLines
        .filter((line) => line.systemKey === "marketing_expense")
        .map((line) => [line.debitZmw, line.creditZmw]).sort(),
      [["16.75", "0.00"], ["7.58", "0.00"]],
    );

    const report = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(report.response.status, 200, JSON.stringify(report.payload));
    const fullCampaign = report.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === fullyCostedCampaign.id,
    );
    const missingCampaign = report.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === missingCostCampaign.id,
    );
    assert.ok(fullCampaign);
    assert.ok(missingCampaign);
    assert.deepEqual({
      orderCount: fullCampaign.orderCount,
      attributedRevenueZmw: fullCampaign.attributedRevenueZmw,
      productCostZmw: fullCampaign.productCostZmw,
      landedCostAdjustmentZmw: fullCampaign.landedCostAdjustmentZmw,
      landedCostAdjustmentDeliveries: fullCampaign.landedCostAdjustmentDeliveries.map(
        (delivery: { deliveryNumber: string; orderNumber: string; deliveryDate: string; adjustmentZmw: string }) => ({
          deliveryNumber: delivery.deliveryNumber,
          orderNumber: delivery.orderNumber,
          deliveryDate: delivery.deliveryDate,
          adjustmentZmw: delivery.adjustmentZmw,
        }),
      ),
      spendZmw: fullCampaign.spendZmw,
      netContributionZmw: fullCampaign.netContributionZmw,
      missingCostOrders: fullCampaign.missingCostOrders,
    }, {
      orderCount: 1,
      attributedRevenueZmw: "300.00",
      productCostZmw: "99.00",
      landedCostAdjustmentZmw: "9.00",
      landedCostAdjustmentDeliveries: [
        {
          deliveryNumber: `MR-${suffix.slice(0, 12)}-F1`,
          orderNumber: fullyCostedOrder.orderNumber,
          deliveryDate: reportDate,
          adjustmentZmw: "3.00",
        },
        {
          deliveryNumber: `MR-${suffix.slice(0, 12)}-F2`,
          orderNumber: fullyCostedOrder.orderNumber,
          deliveryDate: reportDate,
          adjustmentZmw: "6.00",
        },
      ],
      spendZmw: "7.58",
      netContributionZmw: "193.42",
      missingCostOrders: [],
    });
    assert.deepEqual({
      orderCount: missingCampaign.orderCount,
      attributedRevenueZmw: missingCampaign.attributedRevenueZmw,
      productCostZmw: missingCampaign.productCostZmw,
      landedCostAdjustmentZmw: missingCampaign.landedCostAdjustmentZmw,
      landedCostAdjustmentDeliveries: missingCampaign.landedCostAdjustmentDeliveries.map(
        (delivery: { deliveryNumber: string; orderNumber: string; adjustmentZmw: string }) => ({
          deliveryNumber: delivery.deliveryNumber,
          orderNumber: delivery.orderNumber,
          adjustmentZmw: delivery.adjustmentZmw,
        }),
      ),
      netContributionZmw: missingCampaign.netContributionZmw,
      missingCostOrders: missingCampaign.missingCostOrders,
    }, {
      orderCount: 1,
      attributedRevenueZmw: "100.00",
      productCostZmw: "22.00",
      landedCostAdjustmentZmw: "2.00",
      landedCostAdjustmentDeliveries: [{
        deliveryNumber: `MR-${suffix.slice(0, 12)}-M1`,
        orderNumber: missingCostOrder.orderNumber,
        adjustmentZmw: "2.00",
      }],
      netContributionZmw: null,
      missingCostOrders: [missingCostOrder.orderNumber],
    });
    assert.equal(
      report.payload.totals.campaignLinkOrders,
      baseline.payload.totals.campaignLinkOrders + 1,
    );
    assert.equal(
      report.payload.totals.ordersWithoutCampaignLinks,
      baseline.payload.totals.ordersWithoutCampaignLinks + 1,
    );
    assert.equal(
      report.payload.totals.attributedOrders,
      baseline.payload.totals.attributedOrders + 2,
    );
    assert.ok(report.payload.ordersMissingProductCost.some(
      (order: { orderNumber: string; campaignName: string }) =>
        order.orderNumber === missingCostOrder.orderNumber
        && order.campaignName === missingCostCampaign.name,
    ));

    assert.equal(
      (BigInt(report.payload.totals.spendZmw.replace(".", "")) -
        BigInt(baseline.payload.totals.spendZmw.replace(".", ""))).toString(),
      "2433",
    );
    assert.equal(
      (BigInt(report.payload.totals.attributedRevenueZmw.replace(".", "")) -
        BigInt(baseline.payload.totals.attributedRevenueZmw.replace(".", ""))).toString(),
      "40000",
    );
    assert.equal(
      (BigInt(report.payload.totals.productCostZmw.replace(".", "")) -
        BigInt(baseline.payload.totals.productCostZmw.replace(".", ""))).toString(),
      "12100",
    );
    assert.equal(report.payload.totals.netContributionZmw, null);
    assert.equal(
      report.payload.totals.missingCostOrders,
      baseline.payload.totals.missingCostOrders + 1,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM journal_lines WHERE journal_entry_id IN (
          SELECT id FROM journal_entries WHERE source_key LIKE $1
        )`,
        [`${prefix}-%`],
      );
      await client.query("DELETE FROM journal_entries WHERE source_key LIKE $1", [`${prefix}-%`]);
      await client.query(
        `DELETE FROM journal_lines WHERE journal_entry_id IN (
          SELECT id FROM journal_entries
          WHERE source_type = 'marketing_expense'
            AND source_id IN (SELECT id FROM marketing_expenses WHERE description LIKE $1)
        )`,
        [`${prefix}%`],
      );
      await client.query(
        `DELETE FROM journal_entries
         WHERE source_type = 'marketing_expense'
           AND source_id IN (SELECT id FROM marketing_expenses WHERE description LIKE $1)`,
        [`${prefix}%`],
      );
      await client.query(
        `DELETE FROM business_audit_logs WHERE actor_email = $1`,
        [actorEmail],
      );
      await client.query(
        `DELETE FROM marketing_expenses WHERE description LIKE $1`,
        [`${prefix}%`],
      );
      await client.query(
        `DELETE FROM marketing_attributions WHERE sales_order_id IN (
          SELECT id FROM sales_orders WHERE order_number LIKE $1
        )`,
        [`${orderPrefix}-%`],
      );
      await client.query(
        `DELETE FROM sales_delivery_lines WHERE delivery_id IN (
          SELECT id FROM sales_deliveries WHERE sales_order_id IN (
            SELECT id FROM sales_orders WHERE order_number LIKE $1
          )
        )`,
        [`${orderPrefix}-%`],
      );
      await client.query(
        `DELETE FROM sales_deliveries WHERE sales_order_id IN (
          SELECT id FROM sales_orders WHERE order_number LIKE $1
        )`,
        [`${orderPrefix}-%`],
      );
      await client.query(
        `DELETE FROM sales_order_lines WHERE sales_order_id IN (
          SELECT id FROM sales_orders WHERE order_number LIKE $1
        )`,
        [`${orderPrefix}-%`],
      );
      await client.query("DELETE FROM sales_orders WHERE order_number LIKE $1", [`${orderPrefix}-%`]);
      await client.query("DELETE FROM marketing_campaigns WHERE name LIKE $1", [`${prefix}%`]);
      await client.query("DELETE FROM customers WHERE name = $1", [`${prefix} customer`]);
      await client.query("DELETE FROM products WHERE sku = $1", [`MKT-${suffix}`]);
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
