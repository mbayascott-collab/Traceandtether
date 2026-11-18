import assert from "node:assert/strict";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test from "node:test";

test("profitability endpoint rejects malformed, impossible, and reversed date ranges", async () => {
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
      ["malformed start date", "?from=2025-2-01"],
      ["malformed end date", "?to=2025-2-01"],
      ["impossible start date", "?from=2025-02-29"],
      ["impossible end date", "?to=2025-04-31"],
      ["empty supplied date", "?from="],
      ["repeated date parameter", "?from=2025-01-01&from=2025-01-02"],
      ["reversed date range", "?from=2025-03-01&to=2025-02-28"],
    ];

    for (const [description, query] of invalidRequests) {
      const response = await fetch(`${baseUrl}/api/profitability${query}`);
      const payload = await response.json() as { error?: string };
      assert.equal(response.status, 400, description);
      assert.equal(payload.error, "Choose a valid date range.", description);
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await pool.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  }
});
