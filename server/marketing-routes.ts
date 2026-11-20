import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Express, RequestHandler } from "express";
import { db } from "./db";
import { recordBusinessAudit } from "./audit";
import { requireBusinessOwner } from "./access-control";
import { accountingAccounts, customers, inventoryMovements, journalEntries, journalLines, marketingAttributions, marketingCampaignAudienceSnapshots, marketingCampaigns, marketingContentItems, marketingCustomerGroups, marketingExpenses, products, salesDeliveryLines, salesDeliveries, salesOrderLines, salesOrders } from "../shared/schema";
import { customerGroupContactsCsv, matchesCustomerGroup } from "../shared/marketing-customer-groups";
import { campaignSchema, contentSchema, customerGroupSchema, marketingExpenseSchema } from "../shared/marketing-validation";
import {
  allocateLandedCostAdjustments, buildDeliveryCostTotals, cents, formatCents, postJournal,
} from "./accounting-posting";

const bad = (res: import("express").Response, error: z.ZodError) => res.status(400).json({ error: error.issues[0]?.message ?? "Check the submitted details." });
const ratio = (numerator: bigint, denominator: bigint) => {
  if (denominator <= 0n) return null;
  const value = (numerator * 100n + denominator / 2n) / denominator;
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
};

async function loadCustomerHistory() {
  const [allCustomers, orders, lines, deliveryRows] = await Promise.all([
    db.select().from(customers),
    db.select().from(salesOrders).where(eq(salesOrders.status, "fulfilled")),
    db.select().from(salesOrderLines),
    db.select({
      orderId: salesDeliveries.salesOrderId, deliveryDate: salesDeliveries.deliveryDate,
      quantity: salesDeliveryLines.quantity, unitPriceZmw: salesOrderLines.unitPriceZmw,
    }).from(salesDeliveryLines)
      .innerJoin(salesDeliveries, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
      .innerJoin(salesOrderLines, eq(salesDeliveryLines.salesOrderLineId, salesOrderLines.id)),
  ]);
  const revenueByOrder = new Map<number, bigint>();
  const latestDeliveryByOrder = new Map<number, string>();
  const ordersWithDeliveries = new Set<number>();
  const orderById = new Map(orders.map((order) => [order.id, order]));
  for (const row of deliveryRows) {
    ordersWithDeliveries.add(row.orderId);
    revenueByOrder.set(row.orderId, (revenueByOrder.get(row.orderId) ?? 0n) + cents(row.unitPriceZmw) * BigInt(row.quantity));
    const latest = latestDeliveryByOrder.get(row.orderId);
    if (!latest || row.deliveryDate > latest) latestDeliveryByOrder.set(row.orderId, row.deliveryDate);
  }
  for (const line of lines) {
    const order = orderById.get(line.salesOrderId);
    if (order?.status !== "fulfilled" || ordersWithDeliveries.has(order.id)) continue;
    revenueByOrder.set(order.id, (revenueByOrder.get(order.id) ?? 0n) + cents(line.unitPriceZmw) * BigInt(line.quantity));
  }
  const history = new Map<number, { fulfilledOrders: number; lifetimeSalesCents: bigint; lastOrderDate: string | null }>();
  for (const order of orders) {
    if (!revenueByOrder.has(order.id)) continue;
    const current = history.get(order.customerId) ?? { fulfilledOrders: 0, lifetimeSalesCents: 0n, lastOrderDate: null };
    current.fulfilledOrders += 1;
    current.lifetimeSalesCents += revenueByOrder.get(order.id) ?? 0n;
    const date = latestDeliveryByOrder.get(order.id) ?? order.fulfilledAt?.toISOString().slice(0, 10) ?? order.orderDate;
    if (!current.lastOrderDate || date > current.lastOrderDate) current.lastOrderDate = date;
    history.set(order.customerId, current);
  }
  return { customers: allCustomers, history };
}

function zambiaToday() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Africa/Lusaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function getCustomerGroupMembers(group: typeof marketingCustomerGroups.$inferSelect) {
  const { customers: allCustomers, history } = await loadCustomerHistory();
  return allCustomers.filter((customer) => matchesCustomerGroup(group.rules, {
    fulfilledOrders: history.get(customer.id)?.fulfilledOrders ?? 0,
    lifetimeSalesZmw: formatCents(history.get(customer.id)?.lifetimeSalesCents ?? 0n),
    lastOrderDate: history.get(customer.id)?.lastOrderDate ?? null,
  })).map((customer) => ({
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
  }));
}

export async function captureDueCampaignAudienceSnapshots() {
  const today = zambiaToday();
  const dueCampaigns = await db.select().from(marketingCampaigns).where(and(
    eq(marketingCampaigns.status, "active"),
    isNotNull(marketingCampaigns.customerGroupId),
    isNotNull(marketingCampaigns.audienceSnapshotEnabledAt),
    or(isNull(marketingCampaigns.startsOn), lte(marketingCampaigns.startsOn, today)),
    or(isNull(marketingCampaigns.endsOn), gte(marketingCampaigns.endsOn, today)),
  ));
  for (const campaign of dueCampaigns) {
    const [existing] = await db.select({ id: marketingCampaignAudienceSnapshots.id })
      .from(marketingCampaignAudienceSnapshots)
      .where(eq(marketingCampaignAudienceSnapshots.campaignId, campaign.id))
      .limit(1);
    if (existing || campaign.customerGroupId === null) continue;
    const [group] = await db.select().from(marketingCustomerGroups)
      .where(eq(marketingCustomerGroups.id, campaign.customerGroupId)).limit(1);
    if (!group) continue;
    const members = await getCustomerGroupMembers(group);
    await db.insert(marketingCampaignAudienceSnapshots).values({
      campaignId: campaign.id,
      sourceGroupId: group.id,
      groupName: group.name,
      rules: group.rules,
      members,
    }).onConflictDoNothing({ target: marketingCampaignAudienceSnapshots.campaignId });
  }
}

let campaignAudienceSnapshotTimer: NodeJS.Timeout | undefined;
export function startCampaignAudienceSnapshotPolling() {
  if (campaignAudienceSnapshotTimer) return;
  let running = false;
  const capture = async () => {
    if (running) return;
    running = true;
    try {
      await captureDueCampaignAudienceSnapshots();
    } catch (error) {
      console.error("Campaign audience snapshot refresh failed.", error instanceof Error ? error.name : "UnknownError");
    } finally {
      running = false;
    }
  };
  void capture();
  campaignAudienceSnapshotTimer = setInterval(() => void capture(), 60_000);
  campaignAudienceSnapshotTimer.unref();
}

export function registerMarketingRoutes(app: Express, owner: RequestHandler) {
  const ownerOnly = requireBusinessOwner("Only the business owner can manage customer groups.");
  const audienceOwnerOnly = requireBusinessOwner("Only the business owner can review campaign audiences.");
  const campaignLinkOwnerOnly = requireBusinessOwner("Only the business owner can replace campaign tracking links.");

  async function hasCampaign(id: number | null | undefined) {
    if (!id) return true;
    const [campaign] = await db.select({ id: marketingCampaigns.id }).from(marketingCampaigns).where(eq(marketingCampaigns.id, id)).limit(1);
    return Boolean(campaign);
  }
  async function hasCustomerGroup(id: number | null | undefined) {
    if (id == null) return true;
    const [group] = await db.select({ id: marketingCustomerGroups.id }).from(marketingCustomerGroups)
      .where(eq(marketingCustomerGroups.id, id)).limit(1);
    return Boolean(group);
  }
  app.get("/api/marketing/campaigns", owner, async (_req, res) => {
    const canManageAudiences = res.locals.actor?.role === "owner";
    if (canManageAudiences) await captureDueCampaignAudienceSnapshots();
    const campaigns = await db.select().from(marketingCampaigns).orderBy(desc(marketingCampaigns.createdAt));
    const snapshots = canManageAudiences && campaigns.length
      ? await db.select({
        campaignId: marketingCampaignAudienceSnapshots.campaignId,
        capturedAt: marketingCampaignAudienceSnapshots.capturedAt,
      }).from(marketingCampaignAudienceSnapshots)
        .where(inArray(marketingCampaignAudienceSnapshots.campaignId, campaigns.map((campaign) => campaign.id)))
      : [];
    const capturedByCampaign = new Map(snapshots.map((snapshot) => [snapshot.campaignId, snapshot.capturedAt]));
    res.json({
      campaigns: canManageAudiences
        ? campaigns.map((campaign) => ({
          ...campaign,
          audienceSnapshotCapturedAt: capturedByCampaign.get(campaign.id)?.toISOString() ?? null,
        }))
        : campaigns.map((campaign) => ({
          ...campaign,
          customerGroupId: null,
          audienceSnapshotCapturedAt: null,
        })),
    });
  });
  app.get("/api/marketing/campaigns/:id/audience-snapshot", owner, audienceOwnerOnly, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid campaign." });
    const [campaign] = await db.select({ id: marketingCampaigns.id }).from(marketingCampaigns)
      .where(eq(marketingCampaigns.id, id)).limit(1);
    if (!campaign) return res.status(404).json({ error: "Campaign not found." });
    await captureDueCampaignAudienceSnapshots();
    const [snapshot] = await db.select().from(marketingCampaignAudienceSnapshots)
      .where(eq(marketingCampaignAudienceSnapshots.campaignId, id)).limit(1);
    if (!snapshot) return res.status(409).json({ error: "This campaign has not reached its launch date yet." });
    res.json({ snapshot });
  });
  app.post("/api/marketing/campaigns", owner, async (req, res) => {
    const parsed = campaignSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    const canManageAudiences = res.locals.actor?.role === "owner";
    if (!canManageAudiences && Object.hasOwn(req.body ?? {}, "customerGroupId")) {
      return res.status(403).json({ error: "Only the business owner can assign a saved customer group." });
    }
    if (!await hasCustomerGroup(parsed.data.customerGroupId)) return res.status(400).json({ error: "Choose an existing customer group." });
    const campaign = await db.transaction(async (tx) => {
      const [created] = await tx.insert(marketingCampaigns).values({
        ...parsed.data,
        trackingCode: randomUUID(),
        audienceSnapshotEnabledAt: parsed.data.customerGroupId == null ? null : new Date(),
      }).returning();
      await recordBusinessAudit(tx, {
        entityType: "marketing_campaign", entityId: created.id, recordLabel: created.name,
        actor: res.locals.actor, action: "created", changedFields: Object.keys(parsed.data),
      });
      return [created];
    });
    res.status(201).json({
      campaign: canManageAudiences ? campaign : { ...campaign, customerGroupId: null },
    });
  });
  app.patch("/api/marketing/campaigns/:id", owner, async (req, res) => {
    const id = Number(req.params.id), parsed = campaignSchema.safeParse(req.body);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid campaign." });
    if (!parsed.success) return bad(res, parsed.error);
    const canManageAudiences = res.locals.actor?.role === "owner";
    if (!canManageAudiences && Object.hasOwn(req.body ?? {}, "customerGroupId")) {
      return res.status(403).json({ error: "Only the business owner can assign a saved customer group." });
    }
    if (!await hasCustomerGroup(parsed.data.customerGroupId)) return res.status(400).json({ error: "Choose an existing customer group." });
    const [campaign] = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, id)).for("update").limit(1);
      if (!current) return [undefined];
      const audienceChanged = parsed.data.customerGroupId !== undefined
        && parsed.data.customerGroupId !== current.customerGroupId;
      const activated = current.status !== "active" && parsed.data.status === "active";
      const shouldEnableSnapshots = parsed.data.customerGroupId !== null
        && parsed.data.customerGroupId !== undefined
        && (audienceChanged || activated)
        && current.audienceSnapshotEnabledAt === null;
      const [updated] = await tx.update(marketingCampaigns).set({
        ...parsed.data,
        ...(shouldEnableSnapshots ? { audienceSnapshotEnabledAt: new Date() } : {}),
        updatedAt: new Date(),
      }).where(eq(marketingCampaigns.id, id)).returning();
      if (updated) await recordBusinessAudit(tx, {
        entityType: "marketing_campaign", entityId: updated.id, recordLabel: updated.name,
        actor: res.locals.actor, action: "updated", changedFields: Object.keys(parsed.data),
      });
      return [updated];
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found." });
    res.json({
      campaign: canManageAudiences ? campaign : { ...campaign, customerGroupId: null },
    });
  });
  app.post("/api/marketing/campaigns/:id/replace-link", owner, campaignLinkOwnerOnly, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid campaign." });
    const expectedTrackingCode = req.body?.trackingCode;
    if (typeof expectedTrackingCode !== "string" || expectedTrackingCode.length === 0) {
      return res.status(400).json({ error: "Refresh the campaign list before replacing its shop link." });
    }
    const campaign = await db.transaction(async (tx) => {
      const [updated] = await tx.update(marketingCampaigns)
        .set({ trackingCode: randomUUID(), updatedAt: new Date() })
        .where(and(
          eq(marketingCampaigns.id, id),
          eq(marketingCampaigns.trackingCode, expectedTrackingCode),
        )).returning();
      if (updated) await recordBusinessAudit(tx, {
        entityType: "marketing_campaign", entityId: updated.id, recordLabel: updated.name,
        actor: res.locals.actor, action: "updated", changedFields: ["trackingCode"],
      });
      if (updated) return { campaign: updated, conflict: false };
      const [existing] = await tx.select({ id: marketingCampaigns.id })
        .from(marketingCampaigns).where(eq(marketingCampaigns.id, id)).limit(1);
      return { campaign: undefined, conflict: Boolean(existing) };
    });
    if (campaign.conflict) {
      return res.status(409).json({
        error: "This campaign link was already replaced. Refresh the campaign list before trying again.",
      });
    }
    if (!campaign.campaign) return res.status(404).json({ error: "Campaign not found." });
    res.json({ campaign: campaign.campaign });
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
    const [item] = await db.transaction(async (tx) => {
      const [created] = await tx.insert(marketingContentItems).values({
        ...parsed.data, scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null,
      }).returning();
      await recordBusinessAudit(tx, {
        entityType: "marketing_content", entityId: created.id, recordLabel: created.title,
        actor: res.locals.actor, action: "created", changedFields: Object.keys(parsed.data),
      });
      return [created];
    });
    res.status(201).json({ item });
  });
  app.patch("/api/marketing/content/:id", owner, async (req, res) => {
    const id = Number(req.params.id), parsed = contentSchema.safeParse(req.body);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid content item." });
    if (!parsed.success) return bad(res, parsed.error);
    if (!await hasCampaign(parsed.data.campaignId)) return res.status(400).json({ error: "Choose an existing campaign." });
    const [item] = await db.transaction(async (tx) => {
      const [updated] = await tx.update(marketingContentItems).set({
        ...parsed.data, scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null, updatedAt: new Date(),
      }).where(eq(marketingContentItems.id, id)).returning();
      if (updated) await recordBusinessAudit(tx, {
        entityType: "marketing_content", entityId: updated.id, recordLabel: updated.title,
        actor: res.locals.actor, action: "updated", changedFields: Object.keys(parsed.data),
      });
      return [updated];
    });
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
      await recordBusinessAudit(tx, {
        entityType: "marketing_expense", entityId: created.id,
        recordLabel: `${created.category}: ${created.description}`,
        actor: res.locals.actor, action: "created", changedFields: Object.keys(parsed.data),
      });
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

  app.get("/api/marketing/customer-groups", owner, async (_req, res) => {
    if (res.locals.actor?.role !== "owner") {
      return res.json({ groups: [], canManage: false, canViewMembers: false });
    }
    const [groups, { customers: allCustomers, history }] = await Promise.all([
      db.select().from(marketingCustomerGroups).orderBy(asc(marketingCustomerGroups.name)),
      loadCustomerHistory(),
    ]);
    res.json({
      groups: groups.map((group) => ({
        ...group,
        memberCount: allCustomers.filter((customer) => matchesCustomerGroup(group.rules, {
          fulfilledOrders: history.get(customer.id)?.fulfilledOrders ?? 0,
          lifetimeSalesZmw: formatCents(history.get(customer.id)?.lifetimeSalesCents ?? 0n),
          lastOrderDate: history.get(customer.id)?.lastOrderDate ?? null,
        })).length,
      })),
      canManage: res.locals.actor?.role === "owner",
      canViewMembers: res.locals.actor?.role === "owner",
    });
  });
  async function getCustomerGroupMemberDetails(group: typeof marketingCustomerGroups.$inferSelect) {
    const { customers: allCustomers, history } = await loadCustomerHistory();
    return allCustomers.filter((customer) => matchesCustomerGroup(group.rules, {
      fulfilledOrders: history.get(customer.id)?.fulfilledOrders ?? 0,
      lifetimeSalesZmw: formatCents(history.get(customer.id)?.lifetimeSalesCents ?? 0n),
      lastOrderDate: history.get(customer.id)?.lastOrderDate ?? null,
    })).map((customer) => {
      const stats = history.get(customer.id);
      return {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        fulfilledOrders: stats?.fulfilledOrders ?? 0,
        lifetimeSalesZmw: formatCents(stats?.lifetimeSalesCents ?? 0n),
        lastOrderDate: stats?.lastOrderDate ?? null,
      };
    });
  }

  async function findCustomerGroup(req: import("express").Request, res: import("express").Response) {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid customer group." });
      return null;
    }
    const [group] = await db.select().from(marketingCustomerGroups).where(eq(marketingCustomerGroups.id, id)).limit(1);
    if (!group) {
      res.status(404).json({ error: "Customer group not found." });
      return null;
    }
    return group;
  }

  app.get("/api/marketing/customer-groups/:id/members", owner, ownerOnly, async (req, res) => {
    const group = await findCustomerGroup(req, res);
    if (!group) return;
    const members = await getCustomerGroupMemberDetails(group);
    res.json({ group, members });
  });
  app.get("/api/marketing/customer-groups/:id/export.csv", owner, ownerOnly, async (req, res) => {
    const group = await findCustomerGroup(req, res);
    if (!group) return;
    const members = await getCustomerGroupMemberDetails(group);
    const filename = `${group.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "customer-group"}-${group.id}.csv`;
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(customerGroupContactsCsv(members));
  });
  app.post("/api/marketing/customer-groups", owner, ownerOnly, async (req, res) => {
    const parsed = customerGroupSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error);
    const [group] = await db.transaction(async (tx) => {
      const [created] = await tx.insert(marketingCustomerGroups).values(parsed.data).returning();
      await recordBusinessAudit(tx, {
        entityType: "marketing_customer_group", entityId: created.id, recordLabel: created.name,
        actor: res.locals.actor, action: "created", changedFields: Object.keys(parsed.data),
      });
      return [created];
    });
    res.status(201).json({ group });
  });
  app.patch("/api/marketing/customer-groups/:id", owner, ownerOnly, async (req, res) => {
    const id = Number(req.params.id), parsed = customerGroupSchema.safeParse(req.body);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid customer group." });
    if (!parsed.success) return bad(res, parsed.error);
    const [group] = await db.transaction(async (tx) => {
      const [updated] = await tx.update(marketingCustomerGroups).set({
        ...parsed.data, updatedAt: new Date(),
      }).where(eq(marketingCustomerGroups.id, id)).returning();
      if (updated) await recordBusinessAudit(tx, {
        entityType: "marketing_customer_group", entityId: updated.id, recordLabel: updated.name,
        actor: res.locals.actor, action: "updated", changedFields: Object.keys(parsed.data),
      });
      return [updated];
    });
    if (!group) return res.status(404).json({ error: "Customer group not found." });
    res.json({ group });
  });
  app.get("/api/marketing/customer-groups/:id/deletion-impact", owner, ownerOnly, async (req, res) => {
    const group = await findCustomerGroup(req, res);
    if (!group) return;
    const campaigns = await db.select({
      id: marketingCampaigns.id,
      name: marketingCampaigns.name,
    }).from(marketingCampaigns)
      .where(eq(marketingCampaigns.customerGroupId, group.id))
      .orderBy(asc(marketingCampaigns.name), asc(marketingCampaigns.id));
    res.json({ campaigns });
  });
  app.delete("/api/marketing/customer-groups/:id", owner, ownerOnly, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid customer group." });
    const campaignIds = req.body?.campaignIds;
    const replacementGroupId = req.body?.replacementGroupId ?? null;
    if (!Array.isArray(campaignIds) || !campaignIds.every((campaignId: unknown) =>
      Number.isSafeInteger(campaignId) && Number(campaignId) > 0)) {
      return res.status(400).json({ error: "Review the linked campaigns before deleting this group." });
    }
    if (replacementGroupId !== null
      && (!Number.isSafeInteger(replacementGroupId) || replacementGroupId <= 0 || replacementGroupId === id)) {
      return res.status(400).json({ error: "Choose a different existing customer group as the replacement." });
    }
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: marketingCustomerGroups.id, name: marketingCustomerGroups.name })
        .from(marketingCustomerGroups).where(eq(marketingCustomerGroups.id, id)).for("update").limit(1);
      if (!existing) return null;
      if (replacementGroupId !== null) {
        const [replacement] = await tx.select({ id: marketingCustomerGroups.id })
          .from(marketingCustomerGroups).where(eq(marketingCustomerGroups.id, replacementGroupId)).for("update").limit(1);
        if (!replacement) return { missingReplacement: true as const };
      }
      const linkedCampaigns = await tx.select({
        id: marketingCampaigns.id,
        name: marketingCampaigns.name,
      }).from(marketingCampaigns)
        .where(eq(marketingCampaigns.customerGroupId, id))
        .orderBy(asc(marketingCampaigns.name), asc(marketingCampaigns.id));
      const expectedIds = [...campaignIds].sort((a: number, b: number) => a - b);
      const actualIds = linkedCampaigns.map((campaign) => campaign.id).sort((a, b) => a - b);
      if (expectedIds.length !== actualIds.length || expectedIds.some((campaignId, index) => campaignId !== actualIds[index])) {
        return { conflict: true as const, campaigns: linkedCampaigns };
      }
      const changedCampaigns = await tx.update(marketingCampaigns)
        .set({ customerGroupId: replacementGroupId, updatedAt: new Date() })
        .where(eq(marketingCampaigns.customerGroupId, id))
        .returning({ id: marketingCampaigns.id, name: marketingCampaigns.name });
      for (const campaign of changedCampaigns) {
        await recordBusinessAudit(tx, {
          entityType: "marketing_campaign", entityId: campaign.id, recordLabel: campaign.name,
          actor: res.locals.actor, action: "updated", changedFields: ["customerGroupId"],
        });
      }
      await recordBusinessAudit(tx, {
        entityType: "marketing_customer_group", entityId: existing.id, recordLabel: existing.name,
        actor: res.locals.actor, action: "deleted",
      });
      await tx.delete(marketingCustomerGroups).where(eq(marketingCustomerGroups.id, id));
      return { conflict: false as const };
    });
    if (!result) return res.status(404).json({ error: "Customer group not found." });
      if ("missingReplacement" in result) {
        return res.status(404).json({ error: "Replacement customer group not found. Review the list and try again." });
      }
    if (result.conflict) {
      return res.status(409).json({
        error: "Campaign links changed after the warning. Review the updated campaign links and try again.",
        campaigns: result.campaigns,
      });
    }
    res.status(204).end();
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
    const [campaigns, expenses, attributions, orders, lines, allCustomers, deliveryRows, costLines, landedCostAdjustmentLines, returnLines] = await Promise.all([
      db.select().from(marketingCampaigns),
      db.select().from(marketingExpenses),
      db.select().from(marketingAttributions),
      db.select().from(salesOrders).where(inArray(salesOrders.status, ["partially_fulfilled", "fulfilled", "cancelled"])),
      db.select().from(salesOrderLines),
      db.select().from(customers),
      db.select({
        deliveryId: salesDeliveries.id, deliveryNumber: salesDeliveries.deliveryNumber,
        orderId: salesDeliveries.salesOrderId, orderNumber: salesOrders.orderNumber,
        deliveryDate: salesDeliveries.deliveryDate,
        productId: salesOrderLines.productId, quantity: salesDeliveryLines.quantity, unitPriceZmw: salesOrderLines.unitPriceZmw,
      }).from(salesDeliveryLines)
        .innerJoin(salesDeliveries, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
        .innerJoin(salesOrderLines, eq(salesDeliveryLines.salesOrderLineId, salesOrderLines.id))
        .innerJoin(salesOrders, eq(salesDeliveries.salesOrderId, salesOrders.id)),
      db.select({
        deliveryId: journalEntries.sourceId, productId: journalLines.productId, debitZmw: journalLines.debitZmw,
      }).from(journalEntries)
        .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
        .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
        .where(and(
          eq(journalEntries.sourceType, "sales_delivery_cogs"),
          eq(accountingAccounts.systemKey, "cost_of_goods_sold"),
        )),
      db.select({
        productId: journalLines.productId, productName: products.name,
        debitZmw: journalLines.debitZmw, creditZmw: journalLines.creditZmw,
      }).from(journalEntries)
        .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
        .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
        .leftJoin(products, eq(journalLines.productId, products.id))
        .where(and(
          eq(journalEntries.sourceType, "landed_cost_adjustment"),
          eq(accountingAccounts.systemKey, "cost_of_goods_sold"),
        )),
      db.select({
        orderId: salesDeliveries.salesOrderId, returnDate: journalEntries.entryDate,
        sourceType: journalEntries.sourceType, systemKey: accountingAccounts.systemKey,
        debitZmw: journalLines.debitZmw, creditZmw: journalLines.creditZmw,
      }).from(journalEntries)
        .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
        .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
        .innerJoin(inventoryMovements, eq(inventoryMovements.id, journalEntries.sourceId))
        .innerJoin(salesDeliveryLines, eq(salesDeliveryLines.id, inventoryMovements.salesDeliveryLineId))
        .innerJoin(salesDeliveries, eq(salesDeliveries.id, salesDeliveryLines.deliveryId))
        .where(inArray(journalEntries.sourceType, ["sales_return", "sales_return_cogs"])),
    ]);
    const revenueByOrder = new Map<number, bigint>();
    const revenueByOrderInRange = new Map<number, bigint>();
    const returnCostByOrderInRange = new Map<number, bigint>();
    const deliveredInRange = new Set<number>();
    const returnedInRange = new Set<number>();
    const ordersWithDeliveries = new Set(deliveryRows.map((row) => row.orderId));
    const inRange = (date: string) => (!from || date >= from) && (!to || date <= to);
    const { productCostByOrder, ordersMissingCost } = buildDeliveryCostTotals(
      deliveryRows,
      costLines.filter((line): line is typeof line & { deliveryId: number } => line.deliveryId !== null),
      inRange,
    );
    const landedCostAllocations = allocateLandedCostAdjustments(
      deliveryRows,
      costLines.filter((line): line is typeof line & { deliveryId: number } => line.deliveryId !== null),
      landedCostAdjustmentLines,
    );
    const landedCostAdjustmentByOrder = new Map<number, bigint>();
    const deliveryById = new Map(deliveryRows.map((delivery) => [delivery.deliveryId, delivery]));
    for (const [deliveryId, adjustment] of landedCostAllocations.adjustmentByDelivery) {
      const delivery = deliveryById.get(deliveryId);
      if (delivery && inRange(delivery.deliveryDate)) {
        landedCostAdjustmentByOrder.set(
          delivery.orderId,
          (landedCostAdjustmentByOrder.get(delivery.orderId) ?? 0n) + adjustment,
        );
      }
    }
    for (const row of deliveryRows) {
      const value = cents(row.unitPriceZmw) * BigInt(row.quantity);
      revenueByOrder.set(row.orderId, (revenueByOrder.get(row.orderId) ?? 0n) + value);
      if (inRange(row.deliveryDate)) {
        deliveredInRange.add(row.orderId);
        revenueByOrderInRange.set(row.orderId, (revenueByOrderInRange.get(row.orderId) ?? 0n) + value);
      }
    }
    for (const row of returnLines) {
      if (!inRange(row.returnDate)) continue;
      if (row.sourceType === "sales_return" && row.systemKey === "sales_revenue") {
        returnedInRange.add(row.orderId);
        revenueByOrderInRange.set(
          row.orderId,
          (revenueByOrderInRange.get(row.orderId) ?? 0n) - cents(row.debitZmw),
        );
      } else if (row.sourceType === "sales_return_cogs" && row.systemKey === "cost_of_goods_sold") {
        returnedInRange.add(row.orderId);
        returnCostByOrderInRange.set(
          row.orderId,
          (returnCostByOrderInRange.get(row.orderId) ?? 0n) + cents(row.creditZmw),
        );
      }
    }
    for (const line of lines) {
      const order = orders.find((item) => item.id === line.salesOrderId);
      if (order?.status !== "fulfilled" || ordersWithDeliveries.has(order.id)) continue;
      const value = cents(line.unitPriceZmw) * BigInt(line.quantity);
      revenueByOrder.set(order.id, (revenueByOrder.get(order.id) ?? 0n) + value);
      if (inRange(order.orderDate)) {
        deliveredInRange.add(order.id);
        revenueByOrderInRange.set(order.id, (revenueByOrderInRange.get(order.id) ?? 0n) + value);
        ordersMissingCost.add(order.id);
      }
    }
    const attributedCampaign = new Map(attributions.map((row) => [row.salesOrderId, row]));
    const campaignTotals = new Map(campaigns.map((c) => [c.id, {
      orderCount: 0, revenue: 0n, productCost: 0n, landedCostAdjustment: 0n, spend: 0n,
      missingCostOrderNumbers: new Set<string>(), unallocatedCostProducts: new Set<number>(),
    }]));
    const unallocatedProductsByOrder = new Map<number, Set<number>>();
    for (const delivery of deliveryRows) {
      if (!inRange(delivery.deliveryDate) || !landedCostAllocations.unallocatedByProduct.has(delivery.productId)) continue;
      const productsForOrder = unallocatedProductsByOrder.get(delivery.orderId) ?? new Set<number>();
      productsForOrder.add(delivery.productId);
      unallocatedProductsByOrder.set(delivery.orderId, productsForOrder);
    }
    const campaignAdjustmentDeliveries = new Map<number, Map<number, {
      deliveryId: number; deliveryNumber: string; orderNumber: string; deliveryDate: string; adjustmentZmw: string;
    }>>();
    let unattributedRevenue = 0n, unattributedOrders = 0, generalSpend = 0n;
    let campaignLinkOrders = 0, ordersWithoutCampaignLinks = 0;
    for (const order of orders) {
      if (deliveredInRange.has(order.id) || returnedInRange.has(order.id)) {
        const revenue = revenueByOrderInRange.get(order.id) ?? 0n;
        const attribution = attributedCampaign.get(order.id);
        if (attribution?.source === "campaign_link") campaignLinkOrders += 1;
        else ordersWithoutCampaignLinks += 1;
        const campaignId = attribution?.campaignId;
        if (campaignId == null) { unattributedRevenue += revenue; unattributedOrders += 1; }
        else {
          const stat = campaignTotals.get(campaignId);
          if (stat) {
            stat.orderCount += 1;
            stat.revenue += revenue;
            const deliveryCost = productCostByOrder.get(order.id) ?? 0n;
            const landedCostAdjustment = landedCostAdjustmentByOrder.get(order.id) ?? 0n;
            stat.productCost += deliveryCost + landedCostAdjustment - (returnCostByOrderInRange.get(order.id) ?? 0n);
            stat.landedCostAdjustment += landedCostAdjustment;
            if (ordersMissingCost.has(order.id)) stat.missingCostOrderNumbers.add(order.orderNumber);
            for (const productId of unallocatedProductsByOrder.get(order.id) ?? []) stat.unallocatedCostProducts.add(productId);
          }
        }
      }
    }
    for (const [deliveryId, adjustment] of landedCostAllocations.adjustmentByDelivery) {
      const delivery = deliveryById.get(deliveryId);
      if (!delivery || !inRange(delivery.deliveryDate)) continue;
      const campaignId = attributedCampaign.get(delivery.orderId)?.campaignId;
      if (campaignId == null || !campaignTotals.has(campaignId)) continue;
      const deliveries = campaignAdjustmentDeliveries.get(campaignId) ?? new Map();
      deliveries.set(deliveryId, {
        deliveryId,
        deliveryNumber: delivery.deliveryNumber,
        orderNumber: delivery.orderNumber,
        deliveryDate: delivery.deliveryDate,
        adjustmentZmw: formatCents(adjustment),
      });
      campaignAdjustmentDeliveries.set(campaignId, deliveries);
    }
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
        attributedRevenueZmw: formatCents(stat.revenue), productCostZmw: formatCents(stat.productCost),
        landedCostAdjustmentZmw: formatCents(stat.landedCostAdjustment),
        landedCostAdjustmentDeliveries: [...(campaignAdjustmentDeliveries.get(campaign.id)?.values() ?? [])]
          .sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate) || a.deliveryNumber.localeCompare(b.deliveryNumber)),
        spendZmw: formatCents(stat.spend),
        missingCostOrders: [...stat.missingCostOrderNumbers].sort(),
        netContributionZmw: stat.missingCostOrderNumbers.size === 0 && stat.unallocatedCostProducts.size === 0
          ? formatCents(stat.revenue - stat.productCost - stat.spend) : null,
        revenueToSpend: ratio(stat.revenue, stat.spend),
      };
    }).sort((a, b) => cents(b.attributedRevenueZmw) > cents(a.attributedRevenueZmw) ? 1 : cents(b.attributedRevenueZmw) < cents(a.attributedRevenueZmw) ? -1 : 0);
    const lifetime = new Map<number, { orders: number; revenue: bigint }>();
    for (const order of orders.filter((item) => revenueByOrder.has(item.id))) {
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
    const attributedProductCost = campaignRows.reduce((total, row) => total + cents(row.productCostZmw), 0n);
    const attributedLandedCostAdjustment = campaignRows.reduce((total, row) => total + cents(row.landedCostAdjustmentZmw), 0n);
    const campaignSpend = campaignRows.reduce((total, row) => total + cents(row.spendZmw), 0n);
    const totalSpend = campaignSpend + generalSpend;
    const ordersMissingProductCost = campaignRows.flatMap((row) =>
      row.missingCostOrders.map((orderNumber) => ({ orderNumber, campaignName: row.name })),
    );
    const campaignNamesByProduct = new Map<number, Set<string>>();
    const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
    for (const delivery of deliveryRows) {
      if (!inRange(delivery.deliveryDate) || !landedCostAllocations.unallocatedByProduct.has(delivery.productId)) continue;
      const campaignId = attributedCampaign.get(delivery.orderId)?.campaignId;
      const campaign = campaignId == null ? undefined : campaignById.get(campaignId);
      if (!campaign) continue;
      const names = campaignNamesByProduct.get(delivery.productId) ?? new Set<string>();
      names.add(campaign.name);
      campaignNamesByProduct.set(delivery.productId, names);
    }
    const unallocatedLandedCostAdjustments = [...landedCostAllocations.unallocatedByProduct]
      .filter(([productId]) => campaignNamesByProduct.has(productId))
      .map(([productId, adjustment]) => ({
        productId,
        productName: landedCostAdjustmentLines.find((line) => line.productId === productId)?.productName ?? `Product #${productId}`,
        adjustmentZmw: formatCents(adjustment),
        campaignNames: [...campaignNamesByProduct.get(productId)!].sort(),
      }))
      .sort((a, b) => a.productName.localeCompare(b.productName));
    const hasIncompleteLandedCostAllocation = unallocatedLandedCostAdjustments.length > 0;
    res.json({
      period: { from: from || null, to: to || null },
      totals: {
        spendZmw: formatCents(totalSpend), attributedRevenueZmw: formatCents(attributedRevenue),
        productCostZmw: formatCents(attributedProductCost),
        landedCostAdjustmentZmw: formatCents(attributedLandedCostAdjustment),
        unallocatedLandedCostAdjustmentZmw: formatCents(unallocatedLandedCostAdjustments.reduce(
          (total, item) => total + cents(item.adjustmentZmw), 0n,
        )),
        netContributionZmw: ordersMissingProductCost.length === 0 && !hasIncompleteLandedCostAllocation
          ? formatCents(attributedRevenue - attributedProductCost - totalSpend) : null,
        missingCostOrders: ordersMissingProductCost.length,
        attributedOrders: campaignRows.reduce((total, row) => total + row.orderCount, 0),
        campaignLinkOrders, ordersWithoutCampaignLinks,
        unattributedRevenueZmw: formatCents(unattributedRevenue), unattributedOrders,
        revenueToSpend: ratio(attributedRevenue, totalSpend),
      },
      campaigns: campaignRows, ordersMissingProductCost, unallocatedLandedCostAdjustments, segments,
    });
  });
}
