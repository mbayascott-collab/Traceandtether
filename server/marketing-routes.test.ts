import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import test from "node:test";
import {
  accountingAccounts, businessAuditLogs, customers, inventoryMovements, journalEntries, journalLines, marketingAttributions,
  marketingCampaigns, marketingCustomerGroups, marketingExpenses, products, salesDeliveries, salesDeliveryLines,
  salesOrderLines, salesOrders,
} from "../shared/schema";

test("campaign link replacement is owner-only while managers retain ordinary campaign access", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db }, { registerMarketingRoutes }, { createBusinessAccessMiddleware }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
    import("./access-control"),
  ]);
  const suffix = randomUUID();
  const prefix = `campaign-link-access-${suffix}`;
  const actorEmails = [`${prefix}-owner@example.test`, `${prefix}-manager@example.test`];
  const app = express();
  app.use(express.json());
  const access = createBusinessAccessMiddleware(
    async (userId) => ({
      authorized: true as const,
      actor: {
        clerkUserId: userId,
        email: userId === "test-manager" ? actorEmails[1] : actorEmails[0],
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
  let campaignId: number | undefined;
  let managerCreatedCampaignId: number | undefined;
  const request = async (userId: string, path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "x-test-user": userId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, payload: await response.json() as any };
  };

  try {
    const [campaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} original`,
      status: "active",
      trackingCode: suffix,
    }).returning();
    campaignId = campaign.id;

    const managerCampaigns = await request("test-manager", "/api/marketing/campaigns");
    assert.equal(managerCampaigns.response.status, 200, JSON.stringify(managerCampaigns.payload));
    assert.ok(managerCampaigns.payload.campaigns.some((item: { id: number }) => item.id === campaign.id));

    const managerCreate = await request("test-manager", "/api/marketing/campaigns", "POST", {
      name: `${prefix} manager-created`,
      status: "draft",
    });
    assert.equal(managerCreate.response.status, 201, JSON.stringify(managerCreate.payload));
    managerCreatedCampaignId = managerCreate.payload.campaign.id;

    const managerPatch = await request("test-manager", `/api/marketing/campaigns/${campaign.id}`, "PATCH", {
      name: `${prefix} manager edit`,
      status: "active",
    });
    assert.equal(managerPatch.response.status, 200, JSON.stringify(managerPatch.payload));

    const managerReplace = await request("test-manager", `/api/marketing/campaigns/${campaign.id}/replace-link`, "POST");
    assert.equal(managerReplace.response.status, 403, JSON.stringify(managerReplace.payload));
    assert.match(managerReplace.payload.error, /business owner/i);
    assert.match(managerReplace.payload.error, /tracking links/i);

    const [unchangedCampaign] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, campaign.id));
    assert.equal(unchangedCampaign.trackingCode, suffix);

    const ownerReplace = await request("test-owner", `/api/marketing/campaigns/${campaign.id}/replace-link`, "POST", {
      trackingCode: suffix,
    });
    assert.equal(ownerReplace.response.status, 200, JSON.stringify(ownerReplace.payload));
    assert.notEqual(ownerReplace.payload.campaign.trackingCode, suffix);

    const managerCampaignsAfterReplacement = await request("test-manager", "/api/marketing/campaigns");
    assert.equal(managerCampaignsAfterReplacement.response.status, 200, JSON.stringify(managerCampaignsAfterReplacement.payload));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (managerCreatedCampaignId) await db.delete(marketingCampaigns).where(eq(marketingCampaigns.id, managerCreatedCampaignId));
    if (campaignId) await db.delete(marketingCampaigns).where(eq(marketingCampaigns.id, campaignId));
    await db.delete(businessAuditLogs).where(inArray(businessAuditLogs.actorEmail, actorEmails));
  }
});

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
    t.skip("requires the campaign attribution and business audit migrations");
    return;
  }

  const suffix = randomUUID();
  const prefix = `marketing-report-${suffix}`;
  const orderPrefix = `MKT-${suffix.slice(0, 20)}`;
  const actorEmail = `${prefix}@example.test`;
  const reportDate = "9999-12-31";
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

    const deliveries = [
      await db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-F1`, salesOrderId: fullyCostedOrder.id, deliveryDate: reportDate,
      }).returning(),
      await db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-F2`, salesOrderId: fullyCostedOrder.id, deliveryDate: reportDate,
      }).returning(),
      await db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-M1`, salesOrderId: missingCostOrder.id, deliveryDate: reportDate,
      }).returning(),
      await db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-M2`, salesOrderId: missingCostOrder.id, deliveryDate: reportDate,
      }).returning(),
    ];
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
    const lateAdjustmentEntry = await db.transaction((tx) => postJournal(tx, {
      sourceKey: `${prefix}-late-adjustment`,
      sourceType: "landed_cost_adjustment",
      sourceId: product.id,
      memo: `${prefix} late landed-cost adjustment`,
      entryDate: reportDate,
      lines: [
        { accountKey: "cost_of_goods_sold", productId: product.id, debitZmw: "11.01" },
        { accountKey: "inventory", productId: product.id, creditZmw: "11.01" },
      ],
    }));
    const readLateAdjustmentJournal = () => db.select({
      systemKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalEntries.id, lateAdjustmentEntry.id));
    const postedLateAdjustmentJournal = await readLateAdjustmentJournal();
    assert.deepEqual(
      postedLateAdjustmentJournal
        .map((line) => [line.systemKey, line.debitZmw, line.creditZmw])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        ["cost_of_goods_sold", "11.01", "0.00"],
        ["inventory", "0.00", "11.01"],
      ],
    );

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
      productCostZmw: "99.01",
      landedCostAdjustmentZmw: "9.01",
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
          adjustmentZmw: "6.01",
        },
      ],
      spendZmw: "7.58",
      netContributionZmw: "193.41",
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
      "12101",
    );
    assert.equal(report.payload.totals.netContributionZmw, null);
    assert.equal(
      report.payload.totals.missingCostOrders,
      baseline.payload.totals.missingCostOrders + 1,
    );

    await db.transaction((tx) => postJournal(tx, {
      sourceKey: `${prefix}-cogs-${missingDeliveryTwo.id}`,
      sourceType: "sales_delivery_cogs",
      sourceId: missingDeliveryTwo.id,
      memo: `${prefix} missing delivery cost posting`,
      entryDate: reportDate,
      lines: [
        { accountKey: "cost_of_goods_sold", productId: product.id, debitZmw: "10.00" },
        { accountKey: "inventory", productId: product.id, creditZmw: "10.00" },
      ],
    }));

    const completeReport = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(completeReport.response.status, 200, JSON.stringify(completeReport.payload));
    const completeFullCampaign = completeReport.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === fullyCostedCampaign.id,
    );
    const completeMissingCampaign = completeReport.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === missingCostCampaign.id,
    );
    assert.deepEqual({
      productCostZmw: completeFullCampaign.productCostZmw,
      landedCostAdjustmentZmw: completeFullCampaign.landedCostAdjustmentZmw,
      landedCostAdjustmentDeliveries: completeFullCampaign.landedCostAdjustmentDeliveries.map(
        (delivery: { deliveryNumber: string; adjustmentZmw: string }) => [delivery.deliveryNumber, delivery.adjustmentZmw],
      ),
      netContributionZmw: completeFullCampaign.netContributionZmw,
      missingCostOrders: completeFullCampaign.missingCostOrders,
    }, {
      productCostZmw: "98.26",
      landedCostAdjustmentZmw: "8.26",
      landedCostAdjustmentDeliveries: [
        [`MR-${suffix.slice(0, 12)}-F1`, "2.75"],
        [`MR-${suffix.slice(0, 12)}-F2`, "5.51"],
      ],
      netContributionZmw: "194.16",
      missingCostOrders: [],
    });
    assert.deepEqual({
      productCostZmw: completeMissingCampaign.productCostZmw,
      landedCostAdjustmentZmw: completeMissingCampaign.landedCostAdjustmentZmw,
      landedCostAdjustmentDeliveries: completeMissingCampaign.landedCostAdjustmentDeliveries.map(
        (delivery: { deliveryNumber: string; adjustmentZmw: string }) => [delivery.deliveryNumber, delivery.adjustmentZmw],
      ),
      netContributionZmw: completeMissingCampaign.netContributionZmw,
      missingCostOrders: completeMissingCampaign.missingCostOrders,
    }, {
      productCostZmw: "32.75",
      landedCostAdjustmentZmw: "2.75",
      landedCostAdjustmentDeliveries: [
        [`MR-${suffix.slice(0, 12)}-M1`, "1.83"],
        [`MR-${suffix.slice(0, 12)}-M2`, "0.92"],
      ],
      netContributionZmw: "67.25",
      missingCostOrders: [],
    });
    assert.equal(completeReport.payload.totals.landedCostAdjustmentZmw, "11.01");
    assert.equal(
      (BigInt(completeReport.payload.totals.productCostZmw.replace(".", "")) -
        BigInt(baseline.payload.totals.productCostZmw.replace(".", ""))).toString(),
      "13101",
    );
    assert.equal(completeReport.payload.totals.netContributionZmw, "244.66");
    assert.deepEqual(await readLateAdjustmentJournal(), postedLateAdjustmentJournal);

    const crossPeriodBaseline = await request(
      "/api/marketing/reports?from=2025-01-10&to=2025-01-10",
    );
    assert.equal(crossPeriodBaseline.response.status, 200, JSON.stringify(crossPeriodBaseline.payload));

    const [crossPeriodCampaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} cross-period`, status: "active",
    }).returning();
    const [crossPeriodProduct] = await db.insert(products).values({
      sku: `MKT-${suffix}-CROSS`,
      name: `${prefix} cross-period product`,
      sellingPriceZmw: "100.00",
      status: "active",
    }).returning();
    const [crossPeriodOrder] = await db.insert(salesOrders).values({
      orderNumber: `${orderPrefix}-CROSS`,
      customerId: customer.id,
      status: "partially_fulfilled",
      orderDate: "2025-01-01",
    }).returning();
    const [crossPeriodLine] = await db.insert(salesOrderLines).values({
      salesOrderId: crossPeriodOrder.id,
      productId: crossPeriodProduct.id,
      quantity: 3,
      unitPriceZmw: "100.00",
    }).returning();
    const crossPeriodDeliveries = await Promise.all([
      db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-C1`,
        salesOrderId: crossPeriodOrder.id,
        deliveryDate: "2025-01-10",
      }).returning(),
      db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-C2`,
        salesOrderId: crossPeriodOrder.id,
        deliveryDate: "2025-01-11",
      }).returning(),
      db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-C3`,
        salesOrderId: crossPeriodOrder.id,
        deliveryDate: "2025-01-12",
      }).returning(),
    ]);
    const [inRangeDelivery, outOfRangeCostedDelivery, outOfRangeMissingDelivery] =
      crossPeriodDeliveries.map(([delivery]) => delivery);
    await db.insert(salesDeliveryLines).values([
      { deliveryId: inRangeDelivery.id, salesOrderLineId: crossPeriodLine.id, quantity: 1 },
      { deliveryId: outOfRangeCostedDelivery.id, salesOrderLineId: crossPeriodLine.id, quantity: 1 },
      { deliveryId: outOfRangeMissingDelivery.id, salesOrderLineId: crossPeriodLine.id, quantity: 1 },
    ]);
    await db.insert(marketingAttributions).values({
      salesOrderId: crossPeriodOrder.id,
      campaignId: crossPeriodCampaign.id,
      source: "manual",
    });

    const postCrossPeriodEntry = (
      deliveryId: number,
      kind: "revenue" | "cogs",
      amount: string,
      entryDate: string,
    ) => db.transaction((tx) => postJournal(tx, {
      sourceKey: `${prefix}-cross-${kind}-${deliveryId}`,
      sourceType: kind === "revenue" ? "sales_delivery" : "sales_delivery_cogs",
      sourceId: deliveryId,
      memo: `${prefix} cross-period ${kind} posting`,
      entryDate,
      lines: kind === "revenue"
        ? [
          { accountKey: "accounts_receivable", debitZmw: amount },
          { accountKey: "sales_revenue", creditZmw: amount },
        ]
        : [
          { accountKey: "cost_of_goods_sold", productId: crossPeriodProduct.id, debitZmw: amount },
          { accountKey: "inventory", productId: crossPeriodProduct.id, creditZmw: amount },
        ],
    }));
    await Promise.all([
      postCrossPeriodEntry(inRangeDelivery.id, "revenue", "100.00", "2025-01-10"),
      postCrossPeriodEntry(outOfRangeCostedDelivery.id, "revenue", "100.00", "2025-01-11"),
      postCrossPeriodEntry(outOfRangeMissingDelivery.id, "revenue", "100.00", "2025-01-12"),
      postCrossPeriodEntry(inRangeDelivery.id, "cogs", "10.00", "2025-02-01"),
      postCrossPeriodEntry(outOfRangeCostedDelivery.id, "cogs", "30.00", "2025-01-05"),
      db.transaction((tx) => postJournal(tx, {
        sourceKey: `${prefix}-cross-late-adjustment`,
        sourceType: "landed_cost_adjustment",
        sourceId: crossPeriodProduct.id,
        memo: `${prefix} cross-period landed-cost adjustment`,
        entryDate: "2025-02-02",
        lines: [
          { accountKey: "cost_of_goods_sold", productId: crossPeriodProduct.id, debitZmw: "20.00" },
          { accountKey: "inventory", productId: crossPeriodProduct.id, creditZmw: "20.00" },
        ],
      })),
    ]);

    const [returnedMovement] = await db.insert(inventoryMovements).values({
      productId: crossPeriodProduct.id,
      kind: "stock_return",
      quantityDelta: 1,
      reason: `${prefix} campaign report test return`,
      reference: inRangeDelivery.deliveryNumber,
      sourceKey: `${prefix}-return-movement`,
      salesDeliveryLineId: (await db.select({ id: salesDeliveryLines.id })
        .from(salesDeliveryLines)
        .where(eq(salesDeliveryLines.deliveryId, inRangeDelivery.id))
        .limit(1))[0].id,
    }).returning();
    await Promise.all([
      db.transaction((tx) => postJournal(tx, {
        sourceKey: `${prefix}-return-revenue`,
        sourceType: "sales_return",
        sourceId: returnedMovement.id,
        memo: `${prefix} campaign report return revenue reversal`,
        entryDate: "2025-01-13",
        lines: [
          { accountKey: "sales_revenue", debitZmw: "100.00" },
          { accountKey: "accounts_receivable", creditZmw: "100.00" },
        ],
      })),
      db.transaction((tx) => postJournal(tx, {
        sourceKey: `${prefix}-return-cogs`,
        sourceType: "sales_return_cogs",
        sourceId: returnedMovement.id,
        memo: `${prefix} campaign report return cost reversal`,
        entryDate: "2025-01-13",
        lines: [
          { accountKey: "inventory", productId: crossPeriodProduct.id, debitZmw: "10.00" },
          { accountKey: "cost_of_goods_sold", productId: crossPeriodProduct.id, creditZmw: "10.00" },
        ],
      })),
    ]);

    const crossPeriodReport = await request(
      "/api/marketing/reports?from=2025-01-10&to=2025-01-10",
    );
    assert.equal(crossPeriodReport.response.status, 200, JSON.stringify(crossPeriodReport.payload));
    const crossPeriodCampaignReport = crossPeriodReport.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === crossPeriodCampaign.id,
    );
    assert.deepEqual({
      orderCount: crossPeriodCampaignReport.orderCount,
      attributedRevenueZmw: crossPeriodCampaignReport.attributedRevenueZmw,
      productCostZmw: crossPeriodCampaignReport.productCostZmw,
      landedCostAdjustmentZmw: crossPeriodCampaignReport.landedCostAdjustmentZmw,
      landedCostAdjustmentDeliveries: crossPeriodCampaignReport.landedCostAdjustmentDeliveries.map(
        (delivery: { deliveryDate: string; adjustmentZmw: string }) => [delivery.deliveryDate, delivery.adjustmentZmw],
      ),
      netContributionZmw: crossPeriodCampaignReport.netContributionZmw,
      missingCostOrders: crossPeriodCampaignReport.missingCostOrders,
    }, {
      orderCount: 1,
      attributedRevenueZmw: "100.00",
      productCostZmw: "15.00",
      landedCostAdjustmentZmw: "5.00",
      landedCostAdjustmentDeliveries: [["2025-01-10", "5.00"]],
      netContributionZmw: "85.00",
      missingCostOrders: [],
    });

    const centsDelta = (current: string, baselineValue: string) =>
      (BigInt(current.replace(".", "")) - BigInt(baselineValue.replace(".", ""))).toString();
    assert.equal(
      centsDelta(crossPeriodReport.payload.totals.attributedRevenueZmw, crossPeriodBaseline.payload.totals.attributedRevenueZmw),
      "10000",
    );
    assert.equal(
      centsDelta(crossPeriodReport.payload.totals.productCostZmw, crossPeriodBaseline.payload.totals.productCostZmw),
      "1500",
    );
    assert.equal(
      centsDelta(crossPeriodReport.payload.totals.landedCostAdjustmentZmw, crossPeriodBaseline.payload.totals.landedCostAdjustmentZmw),
      "500",
    );
    assert.equal(
      crossPeriodReport.payload.totals.missingCostOrders,
      crossPeriodBaseline.payload.totals.missingCostOrders,
    );
    assert.equal(
      crossPeriodReport.payload.totals.netContributionZmw === null
        ? null
        : crossPeriodBaseline.payload.totals.netContributionZmw === null
          ? "unexpected non-null total"
          : centsDelta(
            crossPeriodReport.payload.totals.netContributionZmw,
            crossPeriodBaseline.payload.totals.netContributionZmw,
          ),
      crossPeriodBaseline.payload.totals.netContributionZmw === null ? null : "8500",
    );
    assert.equal(
      BigInt(centsDelta(
        crossPeriodReport.payload.totals.attributedRevenueZmw,
        crossPeriodBaseline.payload.totals.attributedRevenueZmw,
      ))
        - BigInt(centsDelta(
          crossPeriodReport.payload.totals.productCostZmw,
          crossPeriodBaseline.payload.totals.productCostZmw,
        )),
      8500n,
    );

    const returnDateReport = await request(
      "/api/marketing/reports?from=2025-01-13&to=2025-01-13",
    );
    assert.equal(returnDateReport.response.status, 200, JSON.stringify(returnDateReport.payload));
    const returnDateCampaign = returnDateReport.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === crossPeriodCampaign.id,
    );
    assert.deepEqual({
      orderCount: returnDateCampaign.orderCount,
      attributedRevenueZmw: returnDateCampaign.attributedRevenueZmw,
      productCostZmw: returnDateCampaign.productCostZmw,
      netContributionZmw: returnDateCampaign.netContributionZmw,
    }, {
      orderCount: 1,
      attributedRevenueZmw: "-100.00",
      productCostZmw: "-10.00",
      netContributionZmw: "-90.00",
    });
    assert.equal(returnDateReport.payload.totals.attributedRevenueZmw, "-100.00");
    assert.equal(returnDateReport.payload.totals.productCostZmw, "-10.00");
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
      await client.query("DELETE FROM inventory_movements WHERE source_key LIKE $1", [`${prefix}-return-%`]);
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
      await client.query("DELETE FROM products WHERE sku LIKE $1", [`MKT-${suffix}%`]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});

test("campaign reporting keeps delivered revenue after the remainder of an order is cancelled", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerMarketingRoutes }, { registerSalesRoutes }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
    import("./sales-routes"),
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
    t.skip("requires the campaign attribution and business audit migrations");
    return;
  }

  const suffix = randomUUID();
  const prefix = `cancelled-campaign-order-${suffix}`;
  const actorEmail = `${prefix}@example.test`;
  const reportDate = "9999-12-31";
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerSalesRoutes(app, owner);
  registerMarketingRoutes(app, owner);
  app.use(((error: unknown, _req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  }) as ErrorRequestHandler);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, payload: await response.json() as any };
  };

  let campaignId: number | undefined;
  let customerId: number | undefined;
  let productId: number | undefined;
  let orderId: number | undefined;
  try {
    const before = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(before.response.status, 200, JSON.stringify(before.payload));

    const [campaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} campaign`,
      status: "active",
    }).returning();
    campaignId = campaign.id;
    const [product] = await db.insert(products).values({
      sku: `CANCEL-${suffix}`,
      name: `${prefix} product`,
      sellingPriceZmw: "100.00",
      status: "active",
    }).returning();
    productId = product.id;
    const [customer] = await db.insert(customers).values({
      name: `${prefix} customer`,
    }).returning();
    customerId = customer.id;

    const [order] = await db.insert(salesOrders).values({
      orderNumber: `C-${suffix.slice(0, 30)}`,
      customerId: customer.id,
      status: "partially_fulfilled",
      orderDate: reportDate,
    }).returning();
    orderId = order.id;
    const [line] = await db.insert(salesOrderLines).values({
      salesOrderId: order.id,
      productId: product.id,
      quantity: 5,
      unitPriceZmw: "100.00",
    }).returning();
    const [firstDelivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `CD1-${suffix.slice(0, 32)}`,
      salesOrderId: order.id,
      deliveryDate: reportDate,
    }).returning();
    const [secondDelivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `CD2-${suffix.slice(0, 32)}`,
      salesOrderId: order.id,
      deliveryDate: reportDate,
    }).returning();
    await db.insert(salesDeliveryLines).values([
      { deliveryId: firstDelivery.id, salesOrderLineId: line.id, quantity: 1 },
      { deliveryId: secondDelivery.id, salesOrderLineId: line.id, quantity: 1 },
    ]);
    await db.insert(marketingAttributions).values({
      salesOrderId: order.id,
      campaignId: campaign.id,
      source: "campaign_link",
    });

    const cancelled = await request(`/api/sales-orders/${order.id}/cancel`, "POST", {});
    assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.payload));
    assert.equal(cancelled.payload.order.status, "cancelled");

    const salesOrdersResponse = await request("/api/sales-orders");
    assert.equal(salesOrdersResponse.response.status, 200, JSON.stringify(salesOrdersResponse.payload));
    const salesOrder = salesOrdersResponse.payload.orders.find((item: { id: number }) => item.id === order.id);
    assert.ok(salesOrder);
    assert.equal(salesOrder.deliveredZmw, "200.00");
    assert.equal(salesOrder.totalZmw, "500.00");
    assert.equal(salesOrder.lines[0].deliveredQuantity, 2);
    assert.equal(salesOrder.lines[0].remainingQuantity, 3);
    assert.equal(salesOrder.deliveries.length, 2);

    const report = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(report.response.status, 200, JSON.stringify(report.payload));
    const campaignReport = report.payload.campaigns.find((item: { id: number }) => item.id === campaign.id);
    assert.ok(campaignReport);
    assert.equal(campaignReport.orderCount, 1);
    assert.equal(campaignReport.attributedRevenueZmw, salesOrder.deliveredZmw);
    assert.equal(report.payload.totals.campaignLinkOrders, before.payload.totals.campaignLinkOrders + 1);
    assert.equal(report.payload.totals.attributedOrders, before.payload.totals.attributedOrders + 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      if (orderId) {
        await client.query("DELETE FROM marketing_attributions WHERE sales_order_id = $1", [orderId]);
        await client.query(
          "DELETE FROM sales_delivery_lines WHERE delivery_id IN (SELECT id FROM sales_deliveries WHERE sales_order_id = $1)",
          [orderId],
        );
        await client.query("DELETE FROM sales_deliveries WHERE sales_order_id = $1", [orderId]);
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [orderId]);
        await client.query("DELETE FROM sales_orders WHERE id = $1", [orderId]);
      }
      if (campaignId) await client.query("DELETE FROM marketing_campaigns WHERE id = $1", [campaignId]);
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
      if (productId) await client.query("DELETE FROM products WHERE id = $1", [productId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});

test("clearing a manual campaign assignment moves its totals to unattributed without changing link counts", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerMarketingRoutes }, { registerSalesRoutes }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
    import("./sales-routes"),
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
    t.skip("requires the campaign attribution and business audit migrations");
    return;
  }

  const suffix = randomUUID();
  const prefix = `cleared-campaign-assignment-${suffix}`;
  const actorEmail = `${prefix}@example.test`;
  const reportDate = "9999-12-31";
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerSalesRoutes(app, owner);
  registerMarketingRoutes(app, owner);
  app.use(((error: unknown, _req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  }) as ErrorRequestHandler);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, payload: await response.json() as any };
  };

  let campaignId: number | undefined;
  let customerId: number | undefined;
  let productId: number | undefined;
  const orderIds: number[] = [];
  try {
    const baseline = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(baseline.response.status, 200, JSON.stringify(baseline.payload));

    const [campaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} campaign`, status: "active",
    }).returning();
    campaignId = campaign.id;
    const [product] = await db.insert(products).values({
      sku: `CLR-${suffix}`,
      name: `${prefix} product`,
      sellingPriceZmw: "100.00",
      status: "active",
    }).returning();
    productId = product.id;
    const [customer] = await db.insert(customers).values({ name: `${prefix} customer` }).returning();
    customerId = customer.id;

    const [manualOrder] = await db.insert(salesOrders).values({
      orderNumber: `CLR-M-${suffix.slice(0, 24)}`,
      customerId: customer.id,
      status: "fulfilled",
      orderDate: reportDate,
    }).returning();
    const [linkOrder] = await db.insert(salesOrders).values({
      orderNumber: `CLR-L-${suffix.slice(0, 24)}`,
      customerId: customer.id,
      status: "fulfilled",
      orderDate: reportDate,
    }).returning();
    orderIds.push(manualOrder.id, linkOrder.id);
    await db.insert(salesOrderLines).values([
      { salesOrderId: manualOrder.id, productId: product.id, quantity: 1, unitPriceZmw: "100.00" },
      { salesOrderId: linkOrder.id, productId: product.id, quantity: 1, unitPriceZmw: "50.00" },
    ]);
    await db.insert(marketingAttributions).values([
      { salesOrderId: manualOrder.id, campaignId: campaign.id, source: "manual" },
      { salesOrderId: linkOrder.id, campaignId: campaign.id, source: "campaign_link" },
    ]);

    const beforeClear = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(beforeClear.response.status, 200, JSON.stringify(beforeClear.payload));
    const campaignBefore = beforeClear.payload.campaigns.find((item: { id: number }) => item.id === campaign.id);
    assert.ok(campaignBefore);
    assert.equal(campaignBefore.orderCount, 2);
    assert.equal(campaignBefore.attributedRevenueZmw, "150.00");
    assert.equal(beforeClear.payload.totals.campaignLinkOrders, baseline.payload.totals.campaignLinkOrders + 1);
    assert.equal(beforeClear.payload.totals.ordersWithoutCampaignLinks, baseline.payload.totals.ordersWithoutCampaignLinks + 1);

    const cleared = await request(`/api/sales-orders/${manualOrder.id}/attribution`, "PATCH", { campaignId: null });
    assert.equal(cleared.response.status, 200, JSON.stringify(cleared.payload));
    assert.equal(cleared.payload.campaignId, null);

    const afterClear = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(afterClear.response.status, 200, JSON.stringify(afterClear.payload));
    const campaignAfter = afterClear.payload.campaigns.find((item: { id: number }) => item.id === campaign.id);
    assert.ok(campaignAfter);
    assert.equal(campaignAfter.orderCount, 1);
    assert.equal(campaignAfter.attributedRevenueZmw, "50.00");
    assert.equal(afterClear.payload.totals.attributedOrders, baseline.payload.totals.attributedOrders + 1);
    assert.equal(afterClear.payload.totals.unattributedOrders, baseline.payload.totals.unattributedOrders + 1);
    assert.equal(
      BigInt(afterClear.payload.totals.unattributedRevenueZmw.replace(".", "")) -
        BigInt(baseline.payload.totals.unattributedRevenueZmw.replace(".", "")),
      10000n,
    );
    assert.equal(afterClear.payload.totals.campaignLinkOrders, baseline.payload.totals.campaignLinkOrders + 1);
    assert.equal(afterClear.payload.totals.ordersWithoutCampaignLinks, baseline.payload.totals.ordersWithoutCampaignLinks + 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      if (orderIds.length) {
        await client.query("DELETE FROM marketing_attributions WHERE sales_order_id = ANY($1)", [orderIds]);
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = ANY($1)", [orderIds]);
        await client.query("DELETE FROM sales_orders WHERE id = ANY($1)", [orderIds]);
      }
      if (campaignId) await client.query("DELETE FROM marketing_campaigns WHERE id = $1", [campaignId]);
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
      if (productId) await client.query("DELETE FROM products WHERE id = $1", [productId]);
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
