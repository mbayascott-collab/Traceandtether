import { asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Express, RequestHandler } from "express";
import { db } from "./db";
import { customers, marketingAttributions, marketingCampaigns, marketingContentItems, marketingExpenses, salesOrderLines, salesOrders } from "../shared/schema";
import { campaignSchema, contentSchema, marketingExpenseSchema } from "../shared/marketing-validation";
import { cents, formatCents, postJournal } from "./accounting-posting";

const bad = (res: import("express").Response, error: z.ZodError) => res.status(400).json({ error: error.issues[0]?.message ?? "Check the submitted details." });
const ratio = (numerator: bigint, denominator: bigint) => {
  if (denominator <= 0n) return null;
  const value = (numerator * 100n + denominator / 2n) / denominator;
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
};

export function registerMarketingRoutes(app: Express, owner: RequestHandler) {
  async function hasCampaign(id: number | null | undefined) {
    if (!id) return true;
    const [campaign] = await db.select({ id: marketingCampaigns.id }).from(marketingCampaigns).where(eq(marketingCampaigns.id, id)).limit(1);
    return Boolean(campaign);
  }
  app.get("/api/marketing/campaigns", owner, async (_req, res) => {
    res.json({ campaigns: await db.select().from(marketingCampaigns).orderBy(desc(marketingCampaigns.createdAt)) });
  });
  app.post("/api/marketing/campaigns", owner, async (req, res) => {
    const parsed = campaignSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    const [campaign] = await db.insert(marketingCampaigns).values(parsed.data).returning();
    res.status(201).json({ campaign });
  });
  app.patch("/api/marketing/campaigns/:id", owner, async (req, res) => {
    const id = Number(req.params.id), parsed = campaignSchema.safeParse(req.body);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid campaign." });
    if (!parsed.success) return bad(res, parsed.error);
    const [campaign] = await db.update(marketingCampaigns).set({ ...parsed.data, updatedAt: new Date() }).where(eq(marketingCampaigns.id, id)).returning();
    if (!campaign) return res.status(404).json({ error: "Campaign not found." });
    res.json({ campaign });
  });

  app.get("/api/marketing/content", owner, async (_req, res) => {
    const rows = await db.select({ item: marketingContentItems, campaignName: marketingCampaigns.name })
      .from(marketingContentItems).leftJoin(marketingCampaigns, eq(marketingContentItems.campaignId, marketingCampaigns.id))
      .orderBy(asc(marketingContentItems.scheduledAt), desc(marketingContentItems.createdAt));
    res.json({ content: rows.map(({ item, campaignName }) => ({ ...item, campaignName })) });
  });
  app.post("/api/marketing/content", owner, async (req, res) => {
    const parsed = contentSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    if (!await hasCampaign(parsed.data.campaignId)) return res.status(400).json({ error: "Choose an existing campaign." });
    const [item] = await db.insert(marketingContentItems).values({
      ...parsed.data, scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null,
    }).returning();
    res.status(201).json({ item });
  });
  app.patch("/api/marketing/content/:id", owner, async (req, res) => {
    const id = Number(req.params.id), parsed = contentSchema.safeParse(req.body);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid content item." });
    if (!parsed.success) return bad(res, parsed.error);
    if (!await hasCampaign(parsed.data.campaignId)) return res.status(400).json({ error: "Choose an existing campaign." });
    const [item] = await db.update(marketingContentItems).set({
      ...parsed.data, scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null, updatedAt: new Date(),
    }).where(eq(marketingContentItems.id, id)).returning();
    if (!item) return res.status(404).json({ error: "Content item not found." });
    res.json({ item });
  });

  app.get("/api/marketing/expenses", owner, async (_req, res) => {
    const rows = await db.select({ expense: marketingExpenses, campaignName: marketingCampaigns.name })
      .from(marketingExpenses).leftJoin(marketingCampaigns, eq(marketingExpenses.campaignId, marketingCampaigns.id))
      .orderBy(desc(marketingExpenses.expenseDate), desc(marketingExpenses.createdAt));
    res.json({ expenses: rows.map(({ expense, campaignName }) => ({ ...expense, campaignName })) });
  });
  app.post("/api/marketing/expenses", owner, async (req, res) => {
    const parsed = marketingExpenseSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    if (!await hasCampaign(parsed.data.campaignId)) return res.status(400).json({ error: "Choose an existing campaign." });
    const [expense, amountResult] = await db.transaction(async (tx) => {
      const [created] = await tx.insert(marketingExpenses).values(parsed.data).returning();
      const converted = await tx.execute(sql`select round(${parsed.data.amount}::numeric * ${parsed.data.exchangeRateToZmw}::numeric, 2)::text as amount`);
      const amountZmw = String(converted.rows[0]?.amount ?? "0.00");
      await postJournal(tx, {
        sourceKey: `marketing-expense-${created.id}`, sourceType: "marketing_expense", sourceId: created.id,
        memo: `${created.category}: ${created.description}`, entryDate: created.expenseDate,
        lines: [
          { accountKey: "marketing_expense", debitZmw: amountZmw, description: created.description },
          { accountKey: created.paid ? "cash_bank" : "accounts_payable", creditZmw: amountZmw, description: created.description },
        ],
      });
      return [created, amountZmw];
    });
    res.status(201).json({ expense, amountZmw: amountResult });
  });

  app.get("/api/marketing/reports", owner, async (req, res) => {
    const from = typeof req.query.from === "string" ? req.query.from : "";
    const to = typeof req.query.to === "string" ? req.query.to : "";
    const validDay = (value: string) => {
      if (!value) return true;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const parsed = new Date(`${value}T00:00:00Z`);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    };
    if (!validDay(from) || !validDay(to) || (from && to && from > to)) return res.status(400).json({ error: "Choose a valid report date range." });
    const [campaigns, expenses, attributions, orders, lines, allCustomers] = await Promise.all([
      db.select().from(marketingCampaigns),
      db.select().from(marketingExpenses),
      db.select().from(marketingAttributions),
      db.select().from(salesOrders).where(eq(salesOrders.status, "fulfilled")),
      db.select().from(salesOrderLines),
      db.select().from(customers),
    ]);
    const revenueByOrder = new Map<number, bigint>();
    for (const line of lines) revenueByOrder.set(line.salesOrderId, (revenueByOrder.get(line.salesOrderId) ?? 0n) + cents(line.unitPriceZmw) * BigInt(line.quantity));
    const attributedCampaign = new Map(attributions.map((row) => [row.salesOrderId, row.campaignId]));
    const inRange = (date: string) => (!from || date >= from) && (!to || date <= to);
    const campaignTotals = new Map(campaigns.map((c) => [c.id, { orderCount: 0, revenue: 0n, spend: 0n }]));
    let unattributedRevenue = 0n, unattributedOrders = 0, generalSpend = 0n;
    const fulfilledOrders = orders.filter((o) => {
      const revenue = revenueByOrder.get(o.id) ?? 0n;
      if (inRange(o.orderDate)) {
        const campaignId = attributedCampaign.get(o.id);
        if (campaignId == null) { unattributedRevenue += revenue; unattributedOrders += 1; }
        else {
          const stat = campaignTotals.get(campaignId);
          if (stat) { stat.orderCount += 1; stat.revenue += revenue; }
        }
      }
      return true;
    });
    for (const expense of expenses) {
      if (!inRange(expense.expenseDate)) continue;
      const amountCents = cents(expense.amount);
      const [whole, fraction = ""] = expense.exchangeRateToZmw.split(".");
      const rateUnits = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
      const converted = (amountCents * rateUnits + 50_000_000n) / 100_000_000n;
      const stat = expense.campaignId == null ? undefined : campaignTotals.get(expense.campaignId);
      if (stat) stat.spend += converted;
      else generalSpend += converted;
    }
    const campaignRows = campaigns.map((campaign) => {
      const stat = campaignTotals.get(campaign.id)!;
      return {
        id: campaign.id, name: campaign.name, status: campaign.status, orderCount: stat.orderCount,
        attributedRevenueZmw: formatCents(stat.revenue), spendZmw: formatCents(stat.spend),
        revenueToSpend: ratio(stat.revenue, stat.spend),
      };
    }).sort((a, b) => cents(b.attributedRevenueZmw) > cents(a.attributedRevenueZmw) ? 1 : cents(b.attributedRevenueZmw) < cents(a.attributedRevenueZmw) ? -1 : 0);
    const lifetime = new Map<number, { orders: number; revenue: bigint }>();
    for (const order of fulfilledOrders) {
      const value = lifetime.get(order.customerId) ?? { orders: 0, revenue: 0n };
      value.orders += 1; value.revenue += revenueByOrder.get(order.id) ?? 0n; lifetime.set(order.customerId, value);
    }
    const segmentDefinitions = [
      { key: "no_purchase", name: "No fulfilled purchases", test: (count: number) => count === 0 },
      { key: "first_purchase", name: "One fulfilled order", test: (count: number) => count === 1 },
      { key: "repeat", name: "Repeat customers", test: (count: number) => count >= 2 },
    ];
    const segments = segmentDefinitions.map((segment) => {
      const rows = allCustomers.map((customer) => ({
        customer, stats: lifetime.get(customer.id) ?? { orders: 0, revenue: 0n },
      })).filter(({ stats }) => segment.test(stats.orders));
      return {
        key: segment.key, name: segment.name, customerCount: rows.length,
        fulfilledOrders: rows.reduce((total, row) => total + row.stats.orders, 0),
        salesZmw: formatCents(rows.reduce((total, row) => total + row.stats.revenue, 0n)),
        customers: rows.map(({ customer, stats }) => ({
          id: customer.id, name: customer.name, email: customer.email, phone: customer.phone,
          fulfilledOrders: stats.orders, salesZmw: formatCents(stats.revenue),
        })),
      };
    });
    const attributedRevenue = campaignRows.reduce((total, row) => total + cents(row.attributedRevenueZmw), 0n);
    const campaignSpend = campaignRows.reduce((total, row) => total + cents(row.spendZmw), 0n);
    const totalSpend = campaignSpend + generalSpend;
    res.json({
      period: { from: from || null, to: to || null },
      totals: {
        spendZmw: formatCents(totalSpend), attributedRevenueZmw: formatCents(attributedRevenue),
        attributedOrders: campaignRows.reduce((total, row) => total + row.orderCount, 0),
        unattributedRevenueZmw: formatCents(unattributedRevenue), unattributedOrders,
        revenueToSpend: ratio(attributedRevenue, totalSpend),
      },
      campaigns: campaignRows, segments,
    });
  });
}
