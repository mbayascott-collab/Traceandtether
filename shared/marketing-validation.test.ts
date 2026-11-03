import assert from "node:assert/strict";
import test from "node:test";
import { campaignSchema, contentSchema, marketingExpenseSchema } from "./marketing-validation";

test("validates campaign names, statuses, budgets, and date order", () => {
  const campaign = { name: "Winter promotion", objective: "", channel: "Social", status: "draft", startsOn: "2026-11-01", endsOn: "2026-11-30", budgetZmw: "2500.00", notes: "" };
  assert.equal(campaignSchema.safeParse(campaign).success, true);
  assert.equal(campaignSchema.safeParse({ ...campaign, endsOn: "2026-10-01" }).success, false);
  assert.equal(campaignSchema.safeParse({ ...campaign, startsOn: "2026-02-30" }).success, false);
  assert.equal(campaignSchema.safeParse({ ...campaign, budgetZmw: "-10" }).success, false);
});

test("validates content schedule and published URL", () => {
  const item = { campaignId: 1, title: "Launch post", platform: "Instagram", contentType: "Post", status: "planned", scheduledAt: "2026-11-10T09:00:00.000Z", caption: "", publishedUrl: "", notes: "" };
  assert.equal(contentSchema.safeParse(item).success, true);
  assert.equal(contentSchema.safeParse({ ...item, status: "not-started" }).success, false);
  assert.equal(contentSchema.safeParse({ ...item, publishedUrl: "not a url" }).success, false);
});

test("validates positive marketing expense values and normalizes currency", () => {
  const expense = { campaignId: null, category: "Advertising", description: "Social ad", amount: "100.50", currency: "usd", exchangeRateToZmw: "27.12500000", expenseDate: "2026-11-04", reference: "", notes: "" };
  assert.equal(marketingExpenseSchema.parse(expense).currency, "USD");
  assert.equal(marketingExpenseSchema.safeParse({ ...expense, amount: "0" }).success, false);
  assert.equal(marketingExpenseSchema.safeParse({ ...expense, exchangeRateToZmw: "0" }).success, false);
});
