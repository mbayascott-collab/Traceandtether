import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test from "node:test";

test("concurrent blocked shop submissions preserve aggregate reason totals without visitor details", {
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
    await pool.end();
    t.skip("requires public shop reason-count migrations");
    return;
  }

  const suffix = randomUUID();
  const rateLimitedIp = "198.18.0.1";
  const botCheckIps = Array.from({ length: 12 }, (_, index) => `198.19.${index}.${suffix.slice(0, 2).charCodeAt(0)}`);
  const visitorIps = [rateLimitedIp, ...botCheckIps];
  const visitorIpHashes = visitorIps.map((ip) => createHash("sha256").update(ip).digest("hex"));
  const privateMarker = `visitor-private-${suffix}`;
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(express.json());
  const approvedAccess: RequestHandler = (req, res, next) => {
    const role = req.header("x-test-role");
    if (role) res.locals.actor = { clerkUserId: "analytics-test", email: "test@example.test", role };
    next();
  };
  registerSalesRoutes(app, approvedAccess);
  app.use(((error: unknown, _req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  }) as express.ErrorRequestHandler);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const day = new Date().toISOString().slice(0, 10);
  const summaryUrl = "/api/shop/order-attempt-summary";
  const daysUrl = `/api/shop/order-attempt-days?from=${day}&to=${day}`;
  const analyticsRequest = async (path: string) => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { "x-test-role": "owner" } });
    const payload = await response.json() as Record<string, any>;
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload;
  };
  const postBlockedAttempt = async (ip: string, body: Record<string, unknown>) => {
    const response = await fetch(`${baseUrl}/api/shop/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    });
    return response;
  };

  try {
    const beforeSummary = (await analyticsRequest(summaryUrl)).summary;
    const beforeDays = await analyticsRequest(daysUrl);
    const beforeDay = beforeDays.days.find((item: { day: string }) => item.day === day);
    assert.ok(beforeDay);

    // Fill one visitor's allowance with challenge failures; later attempts from it
    // must all be rejected as rate-limited, even when submitted at the same time.
    const allowance = 5;
    for (let index = 0; index < allowance; index += 1) {
      const response = await postBlockedAttempt(rateLimitedIp, {
        challenge: `invalid-${privateMarker}-${index}`,
        website: "",
      });
      assert.equal(response.status, 400);
      await response.body?.cancel();
    }

    const concurrentRateLimited = Array.from({ length: 24 }, () =>
      postBlockedAttempt(rateLimitedIp, { challenge: `invalid-${privateMarker}`, website: "" }));
    const concurrentChallengeFailures = botCheckIps.slice(0, 6).map((ip, index) =>
      postBlockedAttempt(ip, { challenge: `invalid-${privateMarker}-${index}`, website: "" }));
    const concurrentHoneypotFailures = botCheckIps.slice(6).map((ip) =>
      postBlockedAttempt(ip, { challenge: "", website: privateMarker }));
    const concurrentResponses = await Promise.all([
      ...concurrentRateLimited,
      ...concurrentChallengeFailures,
      ...concurrentHoneypotFailures,
    ]);

    assert.ok(
      concurrentResponses.slice(0, concurrentRateLimited.length).every((response) => response.status === 429),
      "every parallel over-limit submission should be rejected as rate-limited",
    );
    assert.ok(
      concurrentResponses.slice(concurrentRateLimited.length).every((response) => response.status === 400),
      "challenge and honeypot failures should be rejected",
    );
    await Promise.all(concurrentResponses.map((response) => response.body?.cancel()));

    const afterSummaryPayload = await analyticsRequest(summaryUrl);
    const afterDaysPayload = await analyticsRequest(daysUrl);
    const afterSummary = afterSummaryPayload.summary;
    const afterDay = afterDaysPayload.days.find((item: { day: string }) => item.day === day);
    assert.ok(afterDay);

    const expectedBotCheckFailures = allowance + botCheckIps.length;
    const expectedRateLimitedFailures = concurrentRateLimited.length;
    for (const [label, after, before] of [
      ["lifetime", afterSummary, beforeSummary],
      ["daily", afterDay, beforeDay],
    ] as const) {
      assert.equal(after.blocked - before.blocked, expectedBotCheckFailures + expectedRateLimitedFailures, `${label} blocked total`);
      assert.equal(after.rateLimited - before.rateLimited, expectedRateLimitedFailures, `${label} rate-limited total`);
      assert.equal(after.botCheck - before.botCheck, expectedBotCheckFailures, `${label} challenge/honeypot total`);
      assert.equal(after.unclassifiedBlocked - before.unclassifiedBlocked, 0, `${label} unclassified blocked total`);
    }
    assert.deepEqual(Object.keys(afterSummary).sort(), [
      "accepted", "blocked", "botCheck", "rateLimited", "unclassifiedBlocked",
    ]);
    assert.deepEqual(Object.keys(afterDay).sort(), [
      "accepted", "blocked", "botCheck", "day", "rateLimited", "unclassifiedBlocked",
    ]);
    const analyticsText = JSON.stringify({ afterSummaryPayload, afterDaysPayload });
    assert.doesNotMatch(analyticsText, /email|phone|address/i);
    assert.doesNotMatch(analyticsText, new RegExp(privateMarker));
    for (const ip of visitorIps) assert.equal(analyticsText.includes(ip), false);
  } finally {
    try {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await pool.query("DELETE FROM public_shop_order_limits WHERE ip_hash = ANY($1::text[])", [visitorIpHashes]);
    } finally {
      await pool.end();
    }
  }
});
