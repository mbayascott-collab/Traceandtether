import { asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Express, RequestHandler } from "express";
import { db } from "./db";
import { marketingCampaigns, marketingContentItems, marketingExpenses } from "../shared/schema";
import { campaignSchema, contentSchema, marketingExpenseSchema } from "../shared/marketing-validation";
import { postJournal } from "./accounting-posting";

const bad = (res: import("express").Response, error: z.ZodError) => res.status(400).json({ error: error.issues[0]?.message ?? "Check the submitted details." });

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
}
