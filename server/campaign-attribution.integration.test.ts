import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { eq, inArray } from "drizzle-orm";
import test from "node:test";
import {
  inventoryMovements, marketingAttributions, marketingCampaigns, products, salesOrders,
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
    "business_audit_logs.actor_email",
  ]);
  const availableColumns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (table_name, column_name) IN (
         ('marketing_campaigns', 'tracking_code'),
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
  const actorEmail = `campaign-link-auth-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const access: RequestHandler = (req, res, next) => {
    const role = req.header("x-test-role") === "manager" ? "manager" : "owner";
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role };
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
    const replaceLink = async (role: "manager" | "owner") => {
      const response = await fetch(`${baseUrl}/api/marketing/campaigns/${campaign.id}/replace-link`, {
        method: "POST",
        headers: { "x-test-role": role },
      });
      return { response, payload: await response.json() as any };
    };

    const denied = await replaceLink("manager");
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    const [unchangedCampaign] = await db.select({ trackingCode: marketingCampaigns.trackingCode })
      .from(marketingCampaigns).where(eq(marketingCampaigns.id, campaign.id));
    assert.equal(unchangedCampaign?.trackingCode, trackingCode);

    const allowed = await replaceLink("owner");
    assert.equal(allowed.response.status, 200, JSON.stringify(allowed.payload));
    assert.ok(allowed.payload.campaign.trackingCode);
    assert.notEqual(allowed.payload.campaign.trackingCode, trackingCode);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (campaignId) {
      await pool.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
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
  const campaignName = `Attribution route test ${suffix}`;
  const trackingCode = randomUUID();
  const actorEmail = `campaign-attribution-${suffix}@example.test`;
  const clientIp = `198.51.100.${Number.parseInt(suffix.slice(0, 2), 16) % 254 + 1}`;
  const clientIpHash = createHash("sha256").update(clientIp).digest("hex");
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
  const headers = { "content-type": "application/json", "x-forwarded-for": clientIp };
  const request = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? { "x-forwarded-for": clientIp } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json() as any;
    return { response, payload };
  };

  let productId: number | undefined;
  let campaignId: number | undefined;
  const orderNumbers: string[] = [];

  try {
    const [campaign] = await db.insert(marketingCampaigns).values({
      name: campaignName, trackingCode, status: "active",
    }).returning();
    campaignId = campaign.id;
    const [product] = await db.insert(products).values({
      sku: `ATTR-${suffix}`,
      name: `Attribution route product ${suffix}`,
      sellingPriceZmw: "100.00",
      status: "active",
    }).returning();
    productId = product.id;
    await db.insert(inventoryMovements).values({
      productId, kind: "opening_stock", quantityDelta: 5,
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
    await new Promise((resolve) => setTimeout(resolve, 1_700));

    const submitOrder = async (index: number, code: string | undefined, challenge: string) => {
      const { response, payload } = await request("/api/shop/orders", {
        name: `Campaign attribution customer ${suffix}-${index}`,
        phone: `+260 977 ${String(index).padStart(3, "0")} 000`,
        email: "",
        address: "",
        notes: "",
        lines: [{ productId, quantity: 1 }],
        trackingCode: code,
        challenge,
      });
      assert.equal(response.status, 201, JSON.stringify(payload));
      assert.deepEqual(Object.keys(payload).sort(), ["orderNumber"]);
      assert.equal(JSON.stringify(payload).includes(campaignName), false);
      assert.equal(JSON.stringify(payload).includes(code ?? trackingCode), false);
      orderNumbers.push(payload.orderNumber);
    };
    await submitOrder(0, trackingCode, challenges[0]);

    const replaced = await request(`/api/marketing/campaigns/${campaignId}/replace-link`, undefined, "POST");
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
    assert.equal(testOrders.length, 4);

    const manuallyAttributedOrder = testOrders.find((order) => order.orderNumber === orderNumbers[1])!;
    const manualAttribution = await request(
      `/api/sales-orders/${manuallyAttributedOrder.id}/attribution`,
      { campaignId },
      "PATCH",
    );
    assert.equal(manualAttribution.response.status, 200, JSON.stringify(manualAttribution.payload));

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
        salesOrderId: testOrders.find((order) => order.orderNumber === orderNumbers[0])!.id,
        campaignId,
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
    assert.ok(testCampaign);
    assert.equal(testCampaign.orderCount, 3);
    assert.equal(testCampaign.attributedRevenueZmw, "300.00");
    assert.equal(report.payload.totals.campaignLinkOrders - baseline.campaignLinkOrders, 2);
    assert.equal(report.payload.totals.ordersWithoutCampaignLinks - baseline.ordersWithoutCampaignLinks, 2);
    assert.equal(report.payload.totals.attributedOrders - baseline.attributedOrders, 3);
    assert.equal(report.payload.totals.unattributedOrders - baseline.unattributedOrders, 2);
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
      await client.query("DELETE FROM public_shop_order_limits WHERE ip_hash = $1", [clientIpHash]);
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
