import assert from "node:assert/strict";
import test from "node:test";
import { campaignSchema, contentSchema, customerGroupSchema, marketingExpenseSchema } from "./marketing-validation";
import { matchesCustomerGroup } from "./marketing-customer-groups";

test("validates campaign names, statuses, budgets, and date order", () => {
  const campaign = { name: "Winter promotion", objective: "", channel: "Social", status: "draft", startsOn: "2026-11-01", endsOn: "2026-11-30", budgetZmw: "2500.00", notes: "" };
  assert.equal(campaignSchema.safeParse(campaign).success, true);
  assert.equal(campaignSchema.safeParse({ ...campaign, customerGroupId: 12 }).success, true);
  assert.equal(campaignSchema.safeParse({ ...campaign, customerGroupId: null }).success, true);
  assert.equal(campaignSchema.safeParse({ ...campaign, customerGroupId: 0 }).success, false);
  assert.equal(campaignSchema.safeParse({ ...campaign, customerGroupId: "12" }).success, false);
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

test("validates saved customer group names and history rules", () => {
  const group = {
    name: "Recent high-value customers",
    rules: { noOrderInLastDays: 90, minimumLifetimeSalesZmw: "1000.00" },
  };
  assert.equal(customerGroupSchema.safeParse(group).success, true);
  assert.equal(customerGroupSchema.safeParse({ ...group, rules: {} }).success, false);
  assert.equal(customerGroupSchema.safeParse({ ...group, rules: { minimumFulfilledOrders: 5, maximumFulfilledOrders: 2 } }).success, false);
  assert.equal(customerGroupSchema.safeParse({ ...group, rules: { maximumFulfilledOrders: 0 } }).success, true);
  assert.equal(customerGroupSchema.safeParse({ ...group, rules: { minimumLifetimeSalesZmw: "-1" } }).success, false);
});

test("matches saved groups against order count, sales, and recency", () => {
  const rules = customerGroupSchema.parse({
    name: "Lapsed repeat customers",
    rules: { minimumFulfilledOrders: 2, noOrderInLastDays: 30, minimumLifetimeSalesZmw: "500.00" },
  }).rules;
  assert.equal(matchesCustomerGroup(rules, {
    fulfilledOrders: 3, lifetimeSalesZmw: "750.00", lastOrderDate: "2026-10-01",
  }, "2026-11-18"), true);
  assert.equal(matchesCustomerGroup(rules, {
    fulfilledOrders: 3, lifetimeSalesZmw: "750.00", lastOrderDate: "2026-11-01",
  }, "2026-11-18"), false);
  assert.equal(matchesCustomerGroup(rules, {
    fulfilledOrders: 1, lifetimeSalesZmw: "750.00", lastOrderDate: null,
  }, "2026-11-18"), false);
  assert.equal(matchesCustomerGroup(rules, {
    fulfilledOrders: 3, lifetimeSalesZmw: "499.99", lastOrderDate: null,
  }, "2026-11-18"), false);
  const neverOrderedRule = customerGroupSchema.parse({
    name: "Never ordered",
    rules: { maximumFulfilledOrders: 0 },
  }).rules;
  assert.equal(matchesCustomerGroup(neverOrderedRule, {
    fulfilledOrders: 0, lifetimeSalesZmw: "0.00", lastOrderDate: null,
  }, "2026-11-18"), true);
});
