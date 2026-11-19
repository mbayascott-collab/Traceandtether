import assert from "node:assert/strict";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test from "node:test";

test("business report endpoints reject invalid date ranges at the HTTP boundary", async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:1/test";
  const [{ registerBusinessReportRoutes }, { pool }] = await Promise.all([
    import("./business-report-routes"),
    import("./db"),
  ]);
  const app = express();
  const owner: RequestHandler = (_req, _res, next) => next();
  registerBusinessReportRoutes(app, owner);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const invalidRequests = [
      ["/api/profitability", "?from=2025-2-01", "Choose a valid date range.", "malformed start date"],
      ["/api/profitability", "?to=2025-2-01", "Choose a valid date range.", "malformed end date"],
      ["/api/profitability", "?from=2025-02-29", "Choose a valid date range.", "impossible start date"],
      ["/api/profitability", "?to=2025-04-31", "Choose a valid date range.", "impossible end date"],
      ["/api/profitability", "?from=", "Choose a valid date range.", "empty supplied date"],
      ["/api/profitability", "?from=2025-01-01&from=2025-01-02", "Choose a valid date range.", "repeated date parameter"],
      ["/api/profitability", "?from=2025-03-01&to=2025-02-28", "Choose a valid date range.", "reversed date range"],
      ["/api/supplier-analytics", "?from=", "Choose a valid supplier report date range.", "supplier empty supplied date"],
      ["/api/supplier-analytics", "?from=2025-01-01&from=2025-01-02", "Choose a valid supplier report date range.", "supplier repeated start date"],
      ["/api/supplier-analytics", "?to=2025-01-01&to=2025-01-02", "Choose a valid supplier report date range.", "supplier repeated end date"],
      ["/api/supplier-analytics", "?from=2025-2-01", "Choose a valid supplier report date range.", "supplier malformed start date"],
      ["/api/supplier-analytics", "?to=2025-2-01", "Choose a valid supplier report date range.", "supplier malformed end date"],
      ["/api/supplier-analytics", "?from=2025-02-29", "Choose a valid supplier report date range.", "supplier impossible start date"],
      ["/api/supplier-analytics", "?to=2025-04-31", "Choose a valid supplier report date range.", "supplier impossible end date"],
    ];

    for (const [path, query, expectedError, description] of invalidRequests) {
      const response = await fetch(`${baseUrl}${path}${query}`);
      const payload = await response.json() as { error?: string };
      assert.equal(response.status, 400, description);
      assert.equal(payload.error, expectedError, description);
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await pool.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  }
});
