import assert from "node:assert/strict";
import test from "node:test";
import { auditLogCsv } from "./audit-csv";

test("audit history CSV escapes delimiters and spreadsheet formulas", () => {
  const csv = auditLogCsv([{
    id: 9876,
    createdAt: new Date("2026-11-19T12:30:00.000Z"),
    recordLabel: '=HYPERLINK("https://example.invalid","Open")',
    entityType: "sales_order",
    entityId: 42,
    action: "updated",
    actorEmail: "person@example.test",
    changedFields: ["+SUM(1,2)", "brand"],
  }]);

  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /"Date and time","Record","Record type","Record ID","Change ID","Change","Account","Fields"/);
  assert.match(csv, /"'\=HYPERLINK\(""https:\/\/example\.invalid"",""Open""\)"/);
  assert.match(csv, /"'\+SUM\(1,2\), brand"/);
  assert.match(csv, /"sales order","42","9876","updated","person@example\.test"/);
});

test("audit history CSV protects formulas after leading whitespace", () => {
  const csv = auditLogCsv([{
    id: 22,
    createdAt: new Date("2026-11-19T12:30:00.000Z"),
    recordLabel: " \t=1+1",
    entityType: "customer",
    entityId: 7,
    action: "created",
    actorEmail: "person@example.test",
    changedFields: [],
  }]);

  assert.ok(csv.includes(`"' \t=1+1"`));
});
