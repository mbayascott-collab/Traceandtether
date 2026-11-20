import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import test from "node:test";
import {
  businessAuditLogs, inventoryLocations, inventoryMovements, marketingAttributions, marketingCampaigns, products, salesOrders,
} from "../shared/schema";

test("only owners can replace campaign links", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerMarketingRoutes }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
  ]);
  const requiredColumns = new Set([
    "marketing_campaigns.tracking_code",
    "business_audit_logs.actor_clerk_user_id",
    "business_audit_logs.actor_email",
  ]);
  const availableColumns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (table_name, column_name) IN (
         ('marketing_campaigns', 'tracking_code'),
          ('business_audit_logs', 'actor_clerk_user_id'),
         ('business_audit_logs', 'actor_email')
       )`,
  );
  for (const column of availableColumns.rows) requiredColumns.delete(`${column.table_name}.${column.column_name}`);
  if (requiredColumns.size > 0) {
    t.skip("requires campaign-link and business-audit migrations");
    return;
  }

  const suffix = randomUUID();
  const campaignName = `Campaign link authorization test ${suffix}`;
  const trackingCode = randomUUID();
  const actorEmails = {
    owner: `campaign-link-owner-${suffix}@example.test`,
    manager: `campaign-link-manager-${suffix}@example.test`,
  };
  const app = express();
  app.use(express.json());
  const access: RequestHandler = (req, res, next) => {
    const role = req.header("x-test-role") === "manager" ? "manager" : "owner";
    res.locals.actor = {
      clerkUserId: `test-${role}-${suffix}`,
      email: actorEmails[role],
      role,
    };
    next();
  };
  registerMarketingRoutes(app, access);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let campaignId: number | undefined;

  try {
    const [campaign] = await db.insert(marketingCampaigns).values({
      name: campaignName, trackingCode, status: "active",
    }).returning();
    campaignId = campaign.id;
    const replaceLink = async (role: "manager" | "owner", currentTrackingCode?: string) => {
      const response = await fetch(`${baseUrl}/api/marketing/campaigns/${campaign.id}/replace-link`, {
        method: "POST",
        headers: {
          "x-test-role": role,
          ...(currentTrackingCode === undefined ? {} : { "content-type": "application/json" }),
        },
        body: currentTrackingCode === undefined ? undefined : JSON.stringify({ trackingCode: currentTrackingCode }),
      });
      return { response, payload: await response.json() as any };
    };

    const denied = await replaceLink("manager");
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    const [unchangedCampaign] = await db.select({ trackingCode: marketingCampaigns.trackingCode })
      .from(marketingCampaigns).where(eq(marketingCampaigns.id, campaign.id));
    assert.equal(unchangedCampaign?.trackingCode, trackingCode);
    const deniedAudit = await db.select().from(businessAuditLogs).where(and(
      eq(businessAuditLogs.entityType, "marketing_campaign"),
      eq(businessAuditLogs.entityId, campaign.id),
    ));
    assert.equal(
      deniedAudit.some((entry) => entry.changedFields.includes("trackingCode")),
      false,
      "a denied manager request must not create a tracking-code audit entry",
    );

    const allowed = await replaceLink("owner", trackingCode);
    assert.equal(allowed.response.status, 200, JSON.stringify(allowed.payload));
    assert.ok(allowed.payload.campaign.trackingCode);
    assert.notEqual(allowed.payload.campaign.trackingCode, trackingCode);
    const ownerAudit = await db.select().from(businessAuditLogs).where(and(
      eq(businessAuditLogs.entityType, "marketing_campaign"),
      eq(businessAuditLogs.entityId, campaign.id),
    ));
    assert.ok(ownerAudit.some((entry) =>
      entry.action === "updated"
      && entry.recordLabel === campaignName
      && entry.actorClerkUserId === `test-owner-${suffix}`
      && entry.actorEmail === actorEmails.owner
      && entry.changedFields.includes("trackingCode"),
    ), "a successful replacement must identify the campaign and responsible owner in audit history");

    const concurrentResults = await Promise.all([
      replaceLink("owner", allowed.payload.campaign.trackingCode),
      replaceLink("owner", allowed.payload.campaign.trackingCode),
    ]);
    assert.deepEqual(concurrentResults.map(({ response }) => response.status).sort(), [200, 409]);
    const staleResult = concurrentResults.find(({ response }) => response.status === 409)!;
    assert.match(staleResult.payload.error, /already replaced.*refresh/i);
    const successfulResult = concurrentResults.find(({ response }) => response.status === 200)!;
    const [currentCampaign] = await db.select({ trackingCode: marketingCampaigns.trackingCode })
      .from(marketingCampaigns).where(eq(marketingCampaigns.id, campaign.id));
    assert.equal(successfulResult.payload.campaign.trackingCode, currentCampaign?.trackingCode);
    assert.equal(
      concurrentResults.filter(({ payload }) => payload.campaign?.trackingCode === currentCampaign?.trackingCode).length,
      1,
      "only the request that left its returned code active should succeed",
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (campaignId) {
      await pool.query("DELETE FROM business_audit_logs WHERE actor_email = ANY($1)", [Object.values(actorEmails)]);
      await db.delete(marketingCampaigns).where(eq(marketingCampaigns.id, campaignId));
    }
  }
});

test("public shop campaign links attribute orders and reports count them without exposing campaign details", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerSalesRoutes }, { registerMarketingRoutes }] = await Promise.all([
    import("./db"),
    import("./sales-routes"),
    import("./marketing-routes"),
  ]);
  const requiredColumns = new Set([
    "marketing_campaigns.tracking_code",
    "marketing_attributions.source",
    "public_shop_order_limits.ip_hash",
    "public_shop_order_attempt_counts.id",
    "business_audit_logs.actor_email",
  ]);
  const availableColumns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (table_name, column_name) IN (
         ('marketing_campaigns', 'tracking_code'),
         ('marketing_attributions', 'source'),
         ('public_shop_order_limits', 'ip_hash'),
         ('public_shop_order_attempt_counts', 'id'),
         ('business_audit_logs', 'actor_email')
       )`,
  );
  for (const column of availableColumns.rows) requiredColumns.delete(`${column.table_name}.${column.column_name}`);
  if (requiredColumns.size > 0) {
    await pool.end();
    t.skip("requires campaign attribution and public shop database migrations");
    return;
  }

  const suffix = randomUUID();
  const safeSuffix = suffix.replaceAll("-", "");
  const campaignName = `Attribution route test ${suffix}`;
  const trackingCode = randomUUID();
  const actorEmail = `campaign-attribution-${suffix}@example.test`;
  const clientIp = `198.19.${Number.parseInt(safeSuffix.slice(0, 2), 16)}.${Number.parseInt(safeSuffix.slice(2, 4), 16)}`;
  const clientIpHash = createHash("sha256").update(clientIp).digest("hex");
  const scheduledClientIp = `198.20.${Number.parseInt(safeSuffix.slice(4, 6), 16)}.${Number.parseInt(safeSuffix.slice(6, 8), 16)}`;
  const scheduledClientIpHash = createHash("sha256").update(scheduledClientIp).digest("hex");
  const oldReportDate = "2001-01-01";
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerSalesRoutes(app, owner);
  registerMarketingRoutes(app, owner);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", ip = clientIp) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined
        ? { "x-forwarded-for": ip }
        : { "content-type": "application/json", "x-forwarded-for": ip },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json() as any;
    return { response, payload };
  };

  let productId: number | undefined;
  let campaignId: number | undefined;
  let secondCampaignId: number | undefined;
  let scheduledCampaignId: number | undefined;
  const orderNumbers: string[] = [];

  try {
    const [campaign] = await db.insert(marketingCampaigns).values({
      name: campaignName, trackingCode, status: "active",
    }).returning();
    campaignId = campaign.id;
    const [secondCampaign] = await db.insert(marketingCampaigns).values({
      name: `Moved attribution destination ${suffix}`, trackingCode: randomUUID(), status: "active",
    }).returning();
    secondCampaignId = secondCampaign.id;
    const [product] = await db.insert(products).values({
      sku: `ATTR-${suffix}`,
      name: `Attribution route product ${suffix}`,
      sellingPriceZmw: "100.00",
      status: "active",
    }).returning();
    productId = product.id;
    const [mainLocation] = await db.select({ id: inventoryLocations.id }).from(inventoryLocations)
      .where(eq(inventoryLocations.name, "Main")).limit(1);
    await db.insert(inventoryMovements).values({
      productId, locationId: mainLocation?.id ?? null, kind: "opening_stock", quantityDelta: 5,
      reason: `Campaign attribution route test ${suffix}`,
      sourceKey: `campaign-attribution-test-${suffix}`,
    });

    const before = await request(`/api/marketing/reports?from=${oldReportDate}&to=${oldReportDate}`);
    assert.equal(before.response.status, 200);
    const baseline = before.payload.totals;

    const challenges = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const shop = await request("/api/shop/products");
      assert.equal(shop.response.status, 200);
      assert.ok(shop.payload.products.some((item: { id: number }) => item.id === productId));
      challenges.push(shop.payload.challenge);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const submitOrder = async (index: number, code: string | undefined, challenge: string, ip = clientIp) => {
      const { response, payload } = await request("/api/shop/orders", {
        name: `Campaign attribution customer ${suffix}-${index}`,
        phone: `+260 977 ${String(index).padStart(3, "0")} 000`,
        email: "",
        address: "",
        notes: "",
        website: "",
        lines: [{ productId, quantity: 1 }],
        trackingCode: code,
        challenge,
      }, "POST", ip);
      assert.equal(response.status, 201, JSON.stringify(payload));
      assert.deepEqual(Object.keys(payload).sort(), ["orderNumber"]);
      assert.equal(JSON.stringify(payload).includes(campaignName), false);
      assert.equal(JSON.stringify(payload).includes(code ?? trackingCode), false);
      orderNumbers.push(payload.orderNumber);
      return payload.orderNumber as string;
    };
    await submitOrder(0, trackingCode, challenges[0]);

    const replaced = await request(
      `/api/marketing/campaigns/${campaignId}/replace-link`,
      { trackingCode },
      "POST",
    );
    assert.equal(replaced.response.status, 200, JSON.stringify(replaced.payload));
    const replacementCode = replaced.payload.campaign.trackingCode as string;
    assert.ok(replacementCode);
    assert.notEqual(replacementCode, trackingCode);
    await submitOrder(1, trackingCode, challenges[1]);
    await submitOrder(2, replacementCode, challenges[2]);
    await submitOrder(3, undefined, challenges[3]);
    await db.update(marketingCampaigns).set({ status: "paused" }).where(eq(marketingCampaigns.id, campaignId));
    await submitOrder(4, replacementCode, challenges[4]);

    const testOrders = await db.select({ id: salesOrders.id, orderNumber: salesOrders.orderNumber })
      .from(salesOrders).where(inArray(salesOrders.orderNumber, orderNumbers));
    assert.equal(testOrders.length, 5);

    const manuallyAttributedOrder = testOrders.find((order) => order.orderNumber === orderNumbers[3])!;
    const manualAttribution = await request(
      `/api/sales-orders/${manuallyAttributedOrder.id}/attribution`,
      { campaignId },
      "PATCH",
    );
    assert.equal(manualAttribution.response.status, 200, JSON.stringify(manualAttribution.payload));

    const linkAttributedOrder = testOrders.find((order) => order.orderNumber === orderNumbers[0])!;
    const movedAttribution = await request(
      `/api/sales-orders/${linkAttributedOrder.id}/attribution`,
      { campaignId: secondCampaignId },
      "PATCH",
    );
    assert.equal(movedAttribution.response.status, 200, JSON.stringify(movedAttribution.payload));

    const attributions = await db.select().from(marketingAttributions);
    const testAttributions = attributions.filter((row) => testOrders.some((order) => order.id === row.salesOrderId));
    assert.deepEqual(testAttributions.map(({ salesOrderId, campaignId: savedCampaignId, source }) => ({
      salesOrderId, campaignId: savedCampaignId, source,
    })).sort((a, b) => a.salesOrderId - b.salesOrderId), [
      {
        salesOrderId: manuallyAttributedOrder.id,
        campaignId,
        source: "manual",
      },
      {
        salesOrderId: linkAttributedOrder.id,
        campaignId: secondCampaignId,
        source: "campaign_link",
      },
      {
        salesOrderId: testOrders.find((order) => order.orderNumber === orderNumbers[2])!.id,
        campaignId,
        source: "campaign_link",
      },
    ].sort((a, b) => a.salesOrderId - b.salesOrderId));

    await db.update(salesOrders).set({ status: "fulfilled", orderDate: oldReportDate })
      .where(inArray(salesOrders.id, testOrders.map((order) => order.id)));

    const report = await request(`/api/marketing/reports?from=${oldReportDate}&to=${oldReportDate}`);
    assert.equal(report.response.status, 200);
    const testCampaign = report.payload.campaigns.find((item: { id: number }) => item.id === campaignId);
    const destinationCampaign = report.payload.campaigns.find((item: { id: number }) => item.id === secondCampaignId);
    assert.ok(testCampaign);
    assert.ok(destinationCampaign);
    assert.equal(testCampaign.orderCount, 2);
    assert.equal(testCampaign.attributedRevenueZmw, "200.00");
    assert.equal(destinationCampaign.orderCount, 1);
    assert.equal(destinationCampaign.attributedRevenueZmw, "100.00");
    assert.equal(report.payload.totals.campaignLinkOrders - baseline.campaignLinkOrders, 2);
    assert.equal(report.payload.totals.ordersWithoutCampaignLinks - baseline.ordersWithoutCampaignLinks, 3);
    assert.equal(report.payload.totals.attributedOrders - baseline.attributedOrders, 3);
    assert.equal(report.payload.totals.unattributedOrders - baseline.unattributedOrders, 2);

    const [databaseDate] = (await pool.query<{ today: string; tomorrow: string }>(
      "SELECT CURRENT_DATE::text AS today, (CURRENT_DATE + 1)::text AS tomorrow",
    )).rows;
    const scheduledTrackingCode = randomUUID();
    const [scheduledCampaign] = await db.insert(marketingCampaigns).values({
      name: `Scheduled campaign ${suffix}`,
      trackingCode: scheduledTrackingCode,
      status: "active",
      startsOn: databaseDate.tomorrow,
    }).returning();
    scheduledCampaignId = scheduledCampaign.id;
    const getScheduledChallenge = async () => {
      const shop = await request("/api/shop/products", undefined, undefined, scheduledClientIp);
      assert.equal(shop.response.status, 200);
      assert.ok(shop.payload.products.some((item: { id: number }) => item.id === productId));
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      return shop.payload.challenge as string;
    };
    const scheduledOrderNumber = await submitOrder(
      5, scheduledTrackingCode, await getScheduledChallenge(), scheduledClientIp,
    );
    const [scheduledOrder] = await db.select({ id: salesOrders.id }).from(salesOrders)
      .where(eq(salesOrders.orderNumber, scheduledOrderNumber));
    const earlyAttribution = await db.select().from(marketingAttributions)
      .where(eq(marketingAttributions.salesOrderId, scheduledOrder.id));
    assert.equal(earlyAttribution.length, 0, "a future-dated campaign link must not attribute early");

    await db.update(marketingCampaigns).set({ startsOn: databaseDate.today })
      .where(eq(marketingCampaigns.id, scheduledCampaign.id));
    const launchDayOrderNumber = await submitOrder(
      6, scheduledTrackingCode, await getScheduledChallenge(), scheduledClientIp,
    );
    const [launchDayOrder] = await db.select({ id: salesOrders.id }).from(salesOrders)
      .where(eq(salesOrders.orderNumber, launchDayOrderNumber));
    const launchDayAttribution = await db.select().from(marketingAttributions)
      .where(eq(marketingAttributions.salesOrderId, launchDayOrder.id));
    assert.equal(launchDayAttribution.length, 1, "link attribution must become eligible on its start date");
    assert.equal(launchDayAttribution[0].campaignId, scheduledCampaign.id);
    assert.equal(launchDayAttribution[0].source, "campaign_link");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const auditTable = await client.query(
        "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
      );
      if (auditTable.rows[0]?.exists) {
        await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      }
      if (orderNumbers.length) {
        await client.query(
          "DELETE FROM sales_order_lines WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE order_number = ANY($1))",
          [orderNumbers],
        );
        await client.query(`
          WITH deleted AS (
            DELETE FROM sales_orders WHERE order_number = ANY($1) RETURNING customer_id
          )
          DELETE FROM customers WHERE id IN (SELECT customer_id FROM deleted)
        `, [orderNumbers]);
      }
      if (productId) {
        await client.query("DELETE FROM inventory_movements WHERE product_id = $1", [productId]);
        await client.query("DELETE FROM products WHERE id = $1", [productId]);
      }
      if (campaignId) await client.query("DELETE FROM marketing_campaigns WHERE id = $1", [campaignId]);
      if (secondCampaignId) await client.query("DELETE FROM marketing_campaigns WHERE id = $1", [secondCampaignId]);
      if (scheduledCampaignId) await client.query("DELETE FROM marketing_campaigns WHERE id = $1", [scheduledCampaignId]);
      await client.query("DELETE FROM public_shop_order_limits WHERE ip_hash = $1", [clientIpHash]);
      await client.query("DELETE FROM public_shop_order_limits WHERE ip_hash = $1", [scheduledClientIpHash]);
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
