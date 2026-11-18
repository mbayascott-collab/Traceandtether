import assert from "node:assert/strict";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test from "node:test";

test("public shop analytics returns aggregate reason counts only to the owner", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ pool }, { registerSalesRoutes }] = await Promise.all([
    import("./db"),
    import("./sales-routes"),
  ]);
  const requiredColumns = new Set([
    "public_shop_order_attempt_counts.rate_limited_count",
    "public_shop_order_attempt_counts.bot_check_count",
    "public_shop_order_attempt_daily_counts.rate_limited_count",
    "public_shop_order_attempt_daily_counts.bot_check_count",
  ]);
  const availableColumns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (table_name, column_name) IN (
         ('public_shop_order_attempt_counts', 'rate_limited_count'),
         ('public_shop_order_attempt_counts', 'bot_check_count'),
         ('public_shop_order_attempt_daily_counts', 'rate_limited_count'),
         ('public_shop_order_attempt_daily_counts', 'bot_check_count')
       )`,
  );
  for (const column of availableColumns.rows) requiredColumns.delete(`${column.table_name}.${column.column_name}`);
  if (requiredColumns.size > 0) {
    t.skip("requires public shop reason-count migrations");
    return;
  }

  const app = express();
  const approvedAccess: RequestHandler = (req, res, next) => {
    const role = req.header("x-test-role");
    if (role) res.locals.actor = { clerkUserId: "analytics-test", email: "test@example.test", role };
    next();
  };
  registerSalesRoutes(app, approvedAccess);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, role?: string) => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: role ? { "x-test-role": role } : undefined,
    });
    return { response, payload: await response.json() as Record<string, any> };
  };

  try {
    for (const path of [
      "/api/shop/order-attempt-summary",
      "/api/shop/order-attempt-days?from=2026-11-18&to=2026-11-18",
    ]) {
      const denied = await request(path, "manager");
      assert.equal(denied.response.status, 403);
      assert.deepEqual(denied.payload, { error: "Only the business owner can view public shop request activity." });

      const allowed = await request(path, "owner");
      assert.equal(allowed.response.status, 200);
      if (path.includes("summary")) {
        assert.deepEqual(Object.keys(allowed.payload.summary).sort(), [
          "accepted", "blocked", "botCheck", "rateLimited", "unclassifiedBlocked",
        ]);
        assert.equal(JSON.stringify(allowed.payload).includes("email"), false);
        assert.equal(JSON.stringify(allowed.payload).includes("ip"), false);
      } else {
        assert.equal(allowed.payload.days.length, 1);
        assert.deepEqual(Object.keys(allowed.payload.days[0]).sort(), [
          "accepted", "blocked", "botCheck", "day", "rateLimited", "unclassifiedBlocked",
        ]);
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  }
});
