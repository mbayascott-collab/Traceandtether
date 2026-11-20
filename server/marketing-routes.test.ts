import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import test from "node:test";
import {
  accountingAccounts, businessAuditLogs, customers, inventoryMovements, journalEntries, journalLines, marketingAttributions,
  marketingCampaignAudienceSnapshots, marketingCampaigns, marketingCustomerGroups, marketingExpenses, products, salesDeliveries, salesDeliveryLines,
  salesOrderLines, salesOrders,
} from "../shared/schema";

test("campaign link replacement is owner-only while managers retain ordinary campaign access", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db }, { registerMarketingRoutes }, { createBusinessAccessMiddleware }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
    import("./access-control"),
  ]);
  const suffix = randomUUID();
  const prefix = `campaign-link-access-${suffix}`;
  const actorEmails = [`${prefix}-owner@example.test`, `${prefix}-manager@example.test`];
  const app = express();
  app.use(express.json());
  const access = createBusinessAccessMiddleware(
    async (userId) => ({
      authorized: true as const,
      actor: {
        clerkUserId: userId,
        email: userId === "test-manager" ? actorEmails[1] : actorEmails[0],
        role: userId === "test-manager" ? "manager" as const : "owner" as const,
      },
    }),
    (req) => req.header("x-test-user"),
  );
  registerMarketingRoutes(app, access);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let campaignId: number | undefined;
  let managerCreatedCampaignId: number | undefined;
  const request = async (userId: string, path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "x-test-user": userId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, payload: await response.json() as any };
  };

  try {
    const [campaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} original`,
      objective: "Promote repeat purchases",
      channel: "Facebook",
      status: "active",
      startsOn: "2025-01-10",
      endsOn: "2025-02-10",
      budgetZmw: "275.50",
      notes: "Keep the approved promotion details",
      trackingCode: suffix,
    }).returning();
    campaignId = campaign.id;

    const managerCampaigns = await request("test-manager", "/api/marketing/campaigns");
    assert.equal(managerCampaigns.response.status, 200, JSON.stringify(managerCampaigns.payload));
    assert.ok(managerCampaigns.payload.campaigns.some((item: { id: number }) => item.id === campaign.id));

    const managerCreate = await request("test-manager", "/api/marketing/campaigns", "POST", {
      name: `${prefix} manager-created`,
      status: "draft",
    });
    assert.equal(managerCreate.response.status, 201, JSON.stringify(managerCreate.payload));
    managerCreatedCampaignId = managerCreate.payload.campaign.id;

    const managerPatch = await request("test-manager", `/api/marketing/campaigns/${campaign.id}`, "PATCH", {
      name: `${prefix} manager edit`,
      status: "active",
    });
    assert.equal(managerPatch.response.status, 200, JSON.stringify(managerPatch.payload));

    const managerReplace = await request("test-manager", `/api/marketing/campaigns/${campaign.id}/replace-link`, "POST");
    assert.equal(managerReplace.response.status, 403, JSON.stringify(managerReplace.payload));
    assert.match(managerReplace.payload.error, /business owner/i);
    assert.match(managerReplace.payload.error, /tracking links/i);

    const [unchangedCampaign] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, campaign.id));
    assert.equal(unchangedCampaign.trackingCode, suffix);
    const [campaignBeforeOwnerReplace] = await db.select().from(marketingCampaigns)
      .where(eq(marketingCampaigns.id, campaign.id));
    const stableCampaignFields = (item: typeof campaign) => ({
      name: item.name,
      objective: item.objective,
      channel: item.channel,
      status: item.status,
      startsOn: item.startsOn,
      endsOn: item.endsOn,
      budgetZmw: item.budgetZmw,
      notes: item.notes,
      customerGroupId: item.customerGroupId,
    });

    const ownerReplace = await request("test-owner", `/api/marketing/campaigns/${campaign.id}/replace-link`, "POST", {
      trackingCode: suffix,
    });
    assert.equal(ownerReplace.response.status, 200, JSON.stringify(ownerReplace.payload));
    assert.notEqual(ownerReplace.payload.campaign.trackingCode, suffix);
    assert.deepEqual(stableCampaignFields(ownerReplace.payload.campaign), stableCampaignFields(campaignBeforeOwnerReplace));
    const [campaignAfterOwnerReplace] = await db.select().from(marketingCampaigns)
      .where(eq(marketingCampaigns.id, campaign.id));
    assert.deepEqual(stableCampaignFields(campaignAfterOwnerReplace), stableCampaignFields(campaignBeforeOwnerReplace));

    const managerCampaignsAfterReplacement = await request("test-manager", "/api/marketing/campaigns");
    assert.equal(managerCampaignsAfterReplacement.response.status, 200, JSON.stringify(managerCampaignsAfterReplacement.payload));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (managerCreatedCampaignId) await db.delete(marketingCampaigns).where(eq(marketingCampaigns.id, managerCreatedCampaignId));
    if (campaignId) await db.delete(marketingCampaigns).where(eq(marketingCampaigns.id, campaignId));
    await db.delete(businessAuditLogs).where(inArray(businessAuditLogs.actorEmail, actorEmails));
  }
});

test("managers cannot read or change saved campaign audience assignments", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db }, { registerMarketingRoutes }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
  ]);
  const suffix = randomUUID();
  const actorEmails = [`audience-owner-${suffix}@example.test`, `audience-manager-${suffix}@example.test`];
  const app = express();
  app.use(express.json());
  const access: RequestHandler = (req, res, next) => {
    const isManager = req.header("x-role") === "manager";
    res.locals.actor = {
      clerkUserId: `${isManager ? "manager" : "owner"}-${suffix}`,
      email: actorEmails[isManager ? 1 : 0],
      role: isManager ? "manager" : "owner",
    };
    next();
  };
  registerMarketingRoutes(app, access);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let groupId: number | undefined;
  let campaignId: number | undefined;
  const request = async (role: "owner" | "manager", path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "x-role": role,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = response.status === 204 ? null : await response.json() as any;
    return { response, payload };
  };

  try {
    const [group] = await db.insert(marketingCustomerGroups).values({
      name: `Private audience ${suffix}`,
      rules: { minimumFulfilledOrders: 2 },
    }).returning();
    groupId = group.id;
    const audienceEnabledAt = new Date("2026-11-01T00:00:00.000Z");
    const [campaign] = await db.insert(marketingCampaigns).values({
      name: `Audience campaign ${suffix}`,
      status: "active",
      customerGroupId: group.id,
      startsOn: "2099-01-01",
      audienceSnapshotEnabledAt: audienceEnabledAt,
    }).returning();
    campaignId = campaign.id;

    const managerGroups = await request("manager", "/api/marketing/customer-groups");
    assert.equal(managerGroups.response.status, 200);
    assert.deepEqual(managerGroups.payload, { groups: [], canManage: false, canViewMembers: false });

    const managerCampaigns = await request("manager", "/api/marketing/campaigns");
    assert.equal(managerCampaigns.response.status, 200);
    const managerCampaign = managerCampaigns.payload.campaigns.find((item: any) => item.id === campaign.id);
    assert.equal(managerCampaign.customerGroupId, null);
    assert.equal(managerCampaign.audienceSnapshotCapturedAt, null);
    assert.equal(managerCampaign.audienceSnapshotEnabledAt, null);
    assert.equal(JSON.stringify(managerCampaigns.payload).includes(group.name), false);

    const deniedCreate = await request("manager", "/api/marketing/campaigns", "POST", {
      name: `Manager audience attempt ${suffix}`,
      status: "draft",
      customerGroupId: group.id,
    });
    assert.equal(deniedCreate.response.status, 403);

    const deniedClear = await request("manager", `/api/marketing/campaigns/${campaign.id}`, "PATCH", {
      name: campaign.name,
      status: "active",
      customerGroupId: null,
    });
    assert.equal(deniedClear.response.status, 403);

    const managerEdit = await request("manager", `/api/marketing/campaigns/${campaign.id}`, "PATCH", {
      name: `Edited by manager ${suffix}`,
      status: "active",
    });
    assert.equal(managerEdit.response.status, 200, JSON.stringify(managerEdit.payload));
    assert.equal(managerEdit.payload.campaign.customerGroupId, null);
    assert.equal(managerEdit.payload.campaign.audienceSnapshotCapturedAt, null);
    assert.equal(managerEdit.payload.campaign.audienceSnapshotEnabledAt, null);
    const [unchangedAssignment] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, campaign.id));
    assert.equal(unchangedAssignment.customerGroupId, group.id);

    const ownerGroups = await request("owner", "/api/marketing/customer-groups");
    assert.equal(ownerGroups.response.status, 200);
    assert.ok(ownerGroups.payload.groups.some((item: any) => item.id === group.id && item.name === group.name));
    const ownerCampaigns = await request("owner", "/api/marketing/campaigns");
    assert.equal(ownerCampaigns.response.status, 200);
    const ownerCampaign = ownerCampaigns.payload.campaigns.find((item: any) => item.id === campaign.id);
    assert.equal(ownerCampaign.customerGroupId, group.id);
    assert.equal(new Date(ownerCampaign.audienceSnapshotEnabledAt).toISOString(), audienceEnabledAt.toISOString());
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (campaignId) await db.delete(marketingCampaigns).where(eq(marketingCampaigns.id, campaignId));
    if (groupId) await db.delete(marketingCustomerGroups).where(eq(marketingCustomerGroups.id, groupId));
    await db.delete(businessAuditLogs).where(inArray(businessAuditLogs.actorEmail, actorEmails));
  }
});

test("deleting a customer group can move linked campaigns to a replacement atomically", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db }, { registerMarketingRoutes }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
  ]);
  const suffix = randomUUID();
  const actorEmail = `group-replacement-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `owner-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerMarketingRoutes(app, owner);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let oldGroupId: number | undefined;
  let replacementGroupId: number | undefined;
  let campaignId: number | undefined;
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      response,
      payload: response.status === 204 ? null : await response.json() as any,
    };
  };

  try {
    const [oldGroup] = await db.insert(marketingCustomerGroups).values({
      name: `Old audience ${suffix}`,
      rules: { minimumFulfilledOrders: 1 },
    }).returning();
    oldGroupId = oldGroup.id;
    const [replacement] = await db.insert(marketingCustomerGroups).values({
      name: `Replacement audience ${suffix}`,
      rules: { noOrderInLastDays: 90 },
    }).returning();
    replacementGroupId = replacement.id;
    const [campaign] = await db.insert(marketingCampaigns).values({
      name: `Linked campaign ${suffix}`,
      status: "active",
      customerGroupId: oldGroup.id,
    }).returning();
    campaignId = campaign.id;

    const stale = await request(`/api/marketing/customer-groups/${oldGroup.id}`, "DELETE", {
      campaignIds: [],
      replacementGroupId: replacement.id,
    });
    assert.equal(stale.response.status, 409);
    assert.equal((await db.select().from(marketingCustomerGroups).where(eq(marketingCustomerGroups.id, oldGroup.id))).length, 1);

    const removed = await request(`/api/marketing/customer-groups/${oldGroup.id}`, "DELETE", {
      campaignIds: [campaign.id],
      replacementGroupId: replacement.id,
    });
    assert.equal(removed.response.status, 204, JSON.stringify(removed.payload));
    assert.equal((await db.select().from(marketingCustomerGroups).where(eq(marketingCustomerGroups.id, oldGroup.id))).length, 0);
    const [savedCampaign] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, campaign.id));
    assert.equal(savedCampaign.customerGroupId, replacement.id);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (campaignId) await db.delete(marketingCampaigns).where(eq(marketingCampaigns.id, campaignId));
    if (oldGroupId) await db.delete(marketingCustomerGroups).where(eq(marketingCustomerGroups.id, oldGroupId));
    if (replacementGroupId) await db.delete(marketingCustomerGroups).where(eq(marketingCustomerGroups.id, replacementGroupId));
    await db.delete(businessAuditLogs).where(eq(businessAuditLogs.actorEmail, actorEmail));
  }
});

test("campaign launch audiences remain reviewable after group rules change or the group is deleted", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db }, { registerMarketingRoutes }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
  ]);
  const suffix = randomUUID();
  const actorEmails = [`snapshot-owner-${suffix}@example.test`, `snapshot-manager-${suffix}@example.test`];
  const app = express();
  app.use(express.json());
  const access: RequestHandler = (req, res, next) => {
    const isManager = req.header("x-role") === "manager";
    res.locals.actor = {
      clerkUserId: `${isManager ? "manager" : "owner"}-${suffix}`,
      email: actorEmails[isManager ? 1 : 0],
      role: isManager ? "manager" : "owner",
    };
    next();
  };
  registerMarketingRoutes(app, access);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let customerId: number | undefined;
  let groupId: number | undefined;
  let campaignId: number | undefined;
  const request = async (role: "owner" | "manager", path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "x-role": role,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = response.status === 204 ? null : await response.json() as any;
    return { response, payload };
  };

  try {
    const [customer] = await db.insert(customers).values({
      name: `Snapshot customer ${suffix}`,
      email: `snapshot-${suffix}@example.test`,
      phone: `+260-${suffix.slice(0, 8)}`,
    }).returning();
    customerId = customer.id;
    assert.ok(customer.email);
    const [group] = await db.insert(marketingCustomerGroups).values({
      name: `Launch group ${suffix}`,
      rules: { noOrderInLastDays: 365 },
    }).returning();
    groupId = group.id;
    const [campaign] = await db.insert(marketingCampaigns).values({
      name: `Launch snapshot ${suffix}`,
      status: "active",
      startsOn: "2000-01-01",
      customerGroupId: group.id,
      audienceSnapshotEnabledAt: new Date(),
    }).returning();
    campaignId = campaign.id;

    const ownerCampaigns = await request("owner", "/api/marketing/campaigns");
    assert.equal(ownerCampaigns.response.status, 200, JSON.stringify(ownerCampaigns.payload));
    assert.ok(ownerCampaigns.payload.campaigns.find((item: any) => item.id === campaign.id).audienceSnapshotCapturedAt);

    const initial = await request("owner", `/api/marketing/campaigns/${campaign.id}/audience-snapshot`);
    assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
    assert.equal(initial.payload.snapshot.groupName, group.name);
    assert.deepEqual(initial.payload.snapshot.rules, group.rules);
    assert.deepEqual(initial.payload.snapshot.members.map((member: any) => ({
      id: member.id, name: member.name, email: member.email,
    })), [{ id: customer.id, name: customer.name, email: customer.email }]);

    const editedGroup = await request("owner", `/api/marketing/customer-groups/${group.id}`, "PATCH", {
      name: `Changed group ${suffix}`,
      rules: { minimumFulfilledOrders: 100 },
    });
    assert.equal(editedGroup.response.status, 200, JSON.stringify(editedGroup.payload));
    const removedGroup = await request("owner", `/api/marketing/customer-groups/${group.id}`, "DELETE", {
      campaignIds: [campaign.id],
      replacementGroupId: null,
    });
    assert.equal(removedGroup.response.status, 204, JSON.stringify(removedGroup.payload));
    groupId = undefined;

    const preserved = await request("owner", `/api/marketing/campaigns/${campaign.id}/audience-snapshot`);
    assert.equal(preserved.response.status, 200, JSON.stringify(preserved.payload));
    assert.equal(preserved.payload.snapshot.groupName, group.name);
    assert.deepEqual(preserved.payload.snapshot.rules, group.rules);
    assert.equal(preserved.payload.snapshot.members[0].email, customer.email);

    const managerSnapshot = await request("manager", `/api/marketing/campaigns/${campaign.id}/audience-snapshot`);
    assert.equal(managerSnapshot.response.status, 403);
    assert.equal(JSON.stringify(managerSnapshot.payload).includes(customer.email), false);
    const managerCampaigns = await request("manager", "/api/marketing/campaigns");
    const managerCampaign = managerCampaigns.payload.campaigns.find((item: any) => item.id === campaign.id);
    assert.equal(managerCampaign.customerGroupId, null);
    assert.equal(managerCampaign.audienceSnapshotCapturedAt, null);

    const [savedSnapshot] = await db.select().from(marketingCampaignAudienceSnapshots)
      .where(eq(marketingCampaignAudienceSnapshots.campaignId, campaign.id));
    assert.equal(savedSnapshot.groupName, group.name);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (campaignId) await db.delete(marketingCampaigns).where(eq(marketingCampaigns.id, campaignId));
    if (groupId) await db.delete(marketingCustomerGroups).where(eq(marketingCustomerGroups.id, groupId));
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
    await db.delete(businessAuditLogs).where(inArray(businessAuditLogs.actorEmail, actorEmails));
  }
});

test("customer-group CSV downloads are limited to owners", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db }, { registerMarketingRoutes }, { createBusinessAccessMiddleware }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
    import("./access-control"),
  ]);
  const suffix = randomUUID();
  const customerName = `group-export-${suffix}`;
  const contactEmail = `group-export-${suffix}@example.test`;
  const contactPhone = `+260-${suffix.slice(0, 8)}`;
  const groupName = `Group export ${suffix}`;
  const ownerUserId = `test-owner-${suffix}`;
  const managerUserId = `test-manager-${suffix}`;
  const ownerEmail = `${ownerUserId}@example.test`;
  const app = express();
  const access = createBusinessAccessMiddleware(
    async (userId) => ({
      authorized: true as const,
      actor: {
        clerkUserId: userId,
        email: `${userId}@example.test`,
        role: userId.startsWith("test-manager-") ? "manager" as const : "owner" as const,
      },
    }),
    (req) => req.header("x-test-user"),
  );
  registerMarketingRoutes(app, access);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let customerId: number | undefined;
  let groupId: number | undefined;

  try {
    const [customer] = await db.insert(customers).values({
      name: customerName, email: contactEmail, phone: contactPhone,
    }).returning();
    customerId = customer.id;
    const [group] = await db.insert(marketingCustomerGroups).values({
      name: groupName, rules: {},
    }).returning();
    groupId = group.id;

    const download = async (userId?: string, targetGroupId: number | string = group.id) => {
      const response = await fetch(`${baseUrl}/api/marketing/customer-groups/${targetGroupId}/export.csv`, {
        headers: userId ? { "x-test-user": userId } : undefined,
      });
      return { response, body: await response.text() };
    };

    const ownerDownload = await download(ownerUserId);
    assert.equal(ownerDownload.response.status, 200, ownerDownload.body);
    assert.match(ownerDownload.response.headers.get("content-type") ?? "", /text\/csv/i);
    assert.ok(ownerDownload.body.includes(customerName));
    assert.ok(ownerDownload.body.includes(contactEmail));
    assert.ok(ownerDownload.body.includes(contactPhone));
    const successfulExports = await db.select().from(businessAuditLogs).where(and(
      eq(businessAuditLogs.entityType, "marketing_customer_group"),
      eq(businessAuditLogs.entityId, group.id),
      eq(businessAuditLogs.actorEmail, ownerEmail),
      eq(businessAuditLogs.action, "exported"),
    ));
    assert.equal(successfulExports.length, 1);
    assert.equal(successfulExports[0]?.recordLabel, groupName);
    assert.equal(successfulExports[0]?.actorClerkUserId, ownerUserId);
    assert.ok(successfulExports[0]?.createdAt);
    const auditText = JSON.stringify(successfulExports[0]);
    for (const contact of [customerName, contactEmail, contactPhone]) {
      assert.equal(auditText.includes(contact), false, "audit records must not copy customer contact details");
    }

    const managerDownload = await download(managerUserId);
    assert.equal(managerDownload.response.status, 403);
    assert.match(managerDownload.body, /Only the business owner/i);
    assert.ok(!managerDownload.body.includes(customerName));
    assert.ok(!managerDownload.body.includes(contactEmail));
    assert.ok(!managerDownload.body.includes(contactPhone));

    const signedOutDownload = await download();
    assert.equal(signedOutDownload.response.status, 401);
    assert.match(signedOutDownload.body, /Sign in/i);
    assert.ok(!signedOutDownload.body.includes(customerName));
    assert.ok(!signedOutDownload.body.includes(contactEmail));
    assert.ok(!signedOutDownload.body.includes(contactPhone));

    const failedDownload = await download(ownerUserId, "not-a-group");
    assert.equal(failedDownload.response.status, 400);
    const exportsAfterDeniedRequests = await db.select().from(businessAuditLogs).where(and(
      eq(businessAuditLogs.entityType, "marketing_customer_group"),
      eq(businessAuditLogs.entityId, group.id),
      eq(businessAuditLogs.actorEmail, ownerEmail),
      eq(businessAuditLogs.action, "exported"),
    ));
    assert.equal(exportsAfterDeniedRequests.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (groupId) {
      await db.delete(businessAuditLogs).where(and(
        eq(businessAuditLogs.entityType, "marketing_customer_group"),
        eq(businessAuditLogs.entityId, groupId),
        eq(businessAuditLogs.actorEmail, ownerEmail),
      ));
    }
    if (groupId) await db.delete(marketingCustomerGroups).where(eq(marketingCustomerGroups.id, groupId));
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  }
});

test("customer-group CSV exports reflect updated rules and delivered customer history", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db }, { registerMarketingRoutes }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
  ]);
  const suffix = randomUUID();
  const prefix = `group-freshness-${suffix}`;
  const actorEmail = `${prefix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerMarketingRoutes(app, owner);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const [firstName, firstEmail, firstPhone, secondName, secondEmail, secondPhone] = [
    `${prefix} first`, `${prefix}-first@example.test`, `+260-${suffix.slice(0, 8)}`,
    `${prefix} second`, `${prefix}-second@example.test`, `+260-${suffix.slice(8, 16)}`,
  ];
  let firstCustomerId: number | undefined;
  let secondCustomerId: number | undefined;
  let productId: number | undefined;
  let groupId: number | undefined;
  const orderIds: number[] = [];
  const orderLineIds: number[] = [];
  const deliveryIds: number[] = [];
  const deliveryLineIds: number[] = [];
  const dateDaysAgo = (days: number) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().slice(0, 10);
  };
  const olderDeliveryDate = dateDaysAgo(60);
  const recentDeliveryDate = dateDaysAgo(5);

  const download = async () => {
    const response = await fetch(`${baseUrl}/api/marketing/customer-groups/${groupId}/export.csv`);
    return { response, body: await response.text() };
  };
  const patchGroup = async (rules: Record<string, number | string>) => {
    const response = await fetch(`${baseUrl}/api/marketing/customer-groups/${groupId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `${prefix} group`, rules }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
  };
  const assertColumns = (body: string) => {
    assert.equal(body.split("\r\n", 1)[0], '"Name","Email","Phone"');
  };

  try {
    const [firstCustomer] = await db.insert(customers).values({
      name: firstName, email: firstEmail, phone: firstPhone,
    }).returning();
    firstCustomerId = firstCustomer.id;
    const [secondCustomer] = await db.insert(customers).values({
      name: secondName, email: secondEmail, phone: secondPhone,
    }).returning();
    secondCustomerId = secondCustomer.id;
    const [product] = await db.insert(products).values({
      sku: `GF-${suffix}`,
      name: `${prefix} product`,
      sellingPriceZmw: "100.00",
      status: "active",
    }).returning();
    productId = product.id;
    const [group] = await db.insert(marketingCustomerGroups).values({
      name: `${prefix} group`,
      rules: { minimumFulfilledOrders: 2 },
    }).returning();
    groupId = group.id;

    const [firstOrder] = await db.insert(salesOrders).values({
      orderNumber: `GF-${suffix.slice(0, 20)}-1`,
      customerId: firstCustomer.id,
      status: "fulfilled",
      orderDate: olderDeliveryDate,
    }).returning();
    orderIds.push(firstOrder.id);
    const [secondOrder] = await db.insert(salesOrders).values({
      orderNumber: `GF-${suffix.slice(0, 20)}-2`,
      customerId: secondCustomer.id,
      status: "confirmed",
      orderDate: "2026-11-02",
    }).returning();
    orderIds.push(secondOrder.id);
    const orderLines = await db.insert(salesOrderLines).values([
      { salesOrderId: firstOrder.id, productId: product.id, quantity: 2, unitPriceZmw: "100.00" },
      { salesOrderId: secondOrder.id, productId: product.id, quantity: 1, unitPriceZmw: "100.00" },
    ]).returning();
    orderLineIds.push(...orderLines.map((line) => line.id));
    const [delivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `GF-${suffix.slice(0, 16)}-D1`,
      salesOrderId: firstOrder.id,
      deliveryDate: olderDeliveryDate,
    }).returning();
    deliveryIds.push(delivery.id);
    const [deliveryLine] = await db.insert(salesDeliveryLines).values({
      deliveryId: delivery.id,
      salesOrderLineId: orderLines[0]!.id,
      quantity: 1,
    }).returning();
    deliveryLineIds.push(deliveryLine.id);

    const beforeRuleChange = await download();
    assert.equal(beforeRuleChange.response.status, 200, beforeRuleChange.body);
    assertColumns(beforeRuleChange.body);
    assert.ok(!beforeRuleChange.body.includes(firstEmail));
    assert.ok(!beforeRuleChange.body.includes(secondEmail));

    await patchGroup({ minimumFulfilledOrders: 1 });
    const afterRuleChange = await download();
    assert.equal(afterRuleChange.response.status, 200, afterRuleChange.body);
    assertColumns(afterRuleChange.body);
    assert.ok(afterRuleChange.body.includes(firstEmail));
    assert.ok(afterRuleChange.body.includes(firstName));
    assert.ok(afterRuleChange.body.includes(firstPhone));
    assert.ok(!afterRuleChange.body.includes(secondEmail));

    await Promise.all([
      db.update(salesOrders).set({ status: "confirmed" }).where(eq(salesOrders.id, firstOrder.id)),
      db.update(salesOrders).set({ status: "fulfilled" }).where(eq(salesOrders.id, secondOrder.id)),
    ]);
    const afterHistoryChange = await download();
    assert.equal(afterHistoryChange.response.status, 200, afterHistoryChange.body);
    assertColumns(afterHistoryChange.body);
    assert.ok(!afterHistoryChange.body.includes(firstEmail));
    assert.ok(afterHistoryChange.body.includes(secondEmail));
    assert.ok(afterHistoryChange.body.includes(secondName));
    assert.ok(afterHistoryChange.body.includes(secondPhone));

    await Promise.all([
      db.update(salesOrders).set({ status: "fulfilled" }).where(eq(salesOrders.id, firstOrder.id)),
      db.update(salesOrders).set({ status: "confirmed" }).where(eq(salesOrders.id, secondOrder.id)),
    ]);
    const [resetSecondOrder] = await db.select({ status: salesOrders.status })
      .from(salesOrders).where(eq(salesOrders.id, secondOrder.id));
    assert.equal(resetSecondOrder?.status, "confirmed");
    await patchGroup({ noOrderInLastDays: 30 });
    const beforeDeliveryDateChange = await download();
    assert.equal(beforeDeliveryDateChange.response.status, 200, beforeDeliveryDateChange.body);
    assertColumns(beforeDeliveryDateChange.body);
    assert.ok(beforeDeliveryDateChange.body.includes(firstEmail));
    assert.ok(beforeDeliveryDateChange.body.includes(firstName));
    assert.ok(beforeDeliveryDateChange.body.includes(firstPhone));
    await db.update(salesDeliveries).set({ deliveryDate: recentDeliveryDate })
      .where(eq(salesDeliveries.id, deliveryIds[0]!));
    const afterDeliveryDateChange = await download();
    assert.equal(afterDeliveryDateChange.response.status, 200, afterDeliveryDateChange.body);
    assertColumns(afterDeliveryDateChange.body);
    assert.ok(!afterDeliveryDateChange.body.includes(firstEmail));

    await patchGroup({ minimumLifetimeSalesZmw: "150.00" });
    const beforeDeliveredSalesChange = await download();
    assert.equal(beforeDeliveredSalesChange.response.status, 200, beforeDeliveredSalesChange.body);
    assertColumns(beforeDeliveredSalesChange.body);
    assert.ok(!beforeDeliveredSalesChange.body.includes(firstEmail));

    await db.update(salesDeliveryLines).set({ quantity: 2 })
      .where(eq(salesDeliveryLines.id, deliveryLineIds[0]!));
    const afterDeliveredQuantityChange = await download();
    assert.equal(afterDeliveredQuantityChange.response.status, 200, afterDeliveredQuantityChange.body);
    assertColumns(afterDeliveredQuantityChange.body);
    assert.ok(afterDeliveredQuantityChange.body.includes(firstEmail));
    assert.ok(afterDeliveredQuantityChange.body.includes(firstName));
    assert.ok(afterDeliveredQuantityChange.body.includes(firstPhone));

    await db.update(salesOrderLines).set({ unitPriceZmw: "60.00" })
      .where(eq(salesOrderLines.id, orderLineIds[0]!));
    const afterDeliveredPriceChange = await download();
    assert.equal(afterDeliveredPriceChange.response.status, 200, afterDeliveredPriceChange.body);
    assertColumns(afterDeliveredPriceChange.body);
    assert.ok(!afterDeliveredPriceChange.body.includes(firstEmail));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (deliveryLineIds.length) await db.delete(salesDeliveryLines).where(inArray(salesDeliveryLines.id, deliveryLineIds));
    if (deliveryIds.length) await db.delete(salesDeliveries).where(inArray(salesDeliveries.id, deliveryIds));
    if (orderLineIds.length) await db.delete(salesOrderLines).where(inArray(salesOrderLines.id, orderLineIds));
    if (orderIds.length) await db.delete(salesOrders).where(inArray(salesOrders.id, orderIds));
    if (groupId) await db.delete(marketingCustomerGroups).where(eq(marketingCustomerGroups.id, groupId));
    await db.delete(businessAuditLogs).where(eq(businessAuditLogs.actorEmail, actorEmail));
    if (productId) await db.delete(products).where(eq(products.id, productId));
    if (firstCustomerId) await db.delete(customers).where(eq(customers.id, firstCustomerId));
    if (secondCustomerId) await db.delete(customers).where(eq(customers.id, secondCustomerId));
  }
});

test("customer-group membership changes do not rewrite past campaign attribution or reports", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerMarketingRoutes }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
  ]);
  const availableColumns = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'marketing_attributions'
       AND column_name = 'source'`,
  );
  if (availableColumns.rows.length === 0) {
    t.skip("requires the campaign attribution source migration");
    return;
  }

  const suffix = randomUUID();
  const prefix = `audience-history-${suffix}`;
  const reportDate = "9999-12-31";
  const actorEmail = `${prefix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerMarketingRoutes(app, owner);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = async (path: string) => {
    const response = await fetch(`${baseUrl}${path}`);
    return { response, payload: await response.json() as any };
  };
  let customerId: number | undefined;
  let productId: number | undefined;
  let groupId: number | undefined;
  let campaignId: number | undefined;
  const orderIds: number[] = [];
  const orderLineIds: number[] = [];
  let deliveryId: number | undefined;
  let deliveryLineId: number | undefined;

  try {
    const [customer] = await db.insert(customers).values({
      name: `${prefix} customer`,
      email: `${prefix}@example.test`,
      phone: `+260-${suffix.slice(0, 8)}`,
    }).returning();
    customerId = customer.id;
    const [product] = await db.insert(products).values({
      sku: `AH-${suffix}`,
      name: `${prefix} product`,
      sellingPriceZmw: "100.00",
      status: "active",
    }).returning();
    productId = product.id;
    const [group] = await db.insert(marketingCustomerGroups).values({
      name: `${prefix} group`,
      rules: { minimumFulfilledOrders: 2 },
    }).returning();
    groupId = group.id;
    const [campaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} campaign`,
      status: "active",
      customerGroupId: group.id,
    }).returning();
    campaignId = campaign.id;
    const [campaignOrder] = await db.insert(salesOrders).values({
      orderNumber: `AH-C-${suffix.slice(0, 20)}`,
      customerId: customer.id,
      status: "fulfilled",
      orderDate: reportDate,
    }).returning();
    const [historyOrder] = await db.insert(salesOrders).values({
      orderNumber: `AH-H-${suffix.slice(0, 20)}`,
      customerId: customer.id,
      status: "confirmed",
      orderDate: "2000-01-01",
    }).returning();
    orderIds.push(campaignOrder.id, historyOrder.id);
    const [campaignLine, historyLine] = await db.insert(salesOrderLines).values([
      { salesOrderId: campaignOrder.id, productId: product.id, quantity: 1, unitPriceZmw: "100.00" },
      { salesOrderId: historyOrder.id, productId: product.id, quantity: 1, unitPriceZmw: "80.00" },
    ]).returning();
    orderLineIds.push(campaignLine.id, historyLine.id);
    const [delivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `AH-D-${suffix.slice(0, 16)}`,
      salesOrderId: campaignOrder.id,
      deliveryDate: reportDate,
    }).returning();
    deliveryId = delivery.id;
    const [deliveryLine] = await db.insert(salesDeliveryLines).values({
      deliveryId: delivery.id,
      salesOrderLineId: campaignLine.id,
      quantity: 1,
    }).returning();
    deliveryLineId = deliveryLine.id;
    await db.insert(marketingAttributions).values({
      salesOrderId: campaignOrder.id,
      campaignId: campaign.id,
      source: "manual",
    });

    const getAudienceCount = async () => {
      const result = await request("/api/marketing/customer-groups");
      assert.equal(result.response.status, 200, JSON.stringify(result.payload));
      return result.payload.groups.find((item: { id: number }) => item.id === group.id)?.memberCount;
    };
    const getCampaignReport = async () => {
      const result = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
      assert.equal(result.response.status, 200, JSON.stringify(result.payload));
      const row = result.payload.campaigns.find((item: { id: number }) => item.id === campaign.id);
      assert.ok(row, JSON.stringify(result.payload));
      return row;
    };

    const audienceCountBefore = await getAudienceCount();
    const membersBefore = await request(`/api/marketing/customer-groups/${group.id}/members`);
    assert.equal(membersBefore.response.status, 200, JSON.stringify(membersBefore.payload));
    assert.equal(membersBefore.payload.members.some((member: { id: number }) => member.id === customer.id), false);
    const memberCountBefore = membersBefore.payload.members.length;
    const reportBeforeHistoryChange = await getCampaignReport();
    assert.equal(reportBeforeHistoryChange.orderCount, 1);
    assert.equal(reportBeforeHistoryChange.attributedRevenueZmw, "100.00");
    const [attributionBefore] = await db.select({
      campaignId: marketingAttributions.campaignId,
      source: marketingAttributions.source,
    }).from(marketingAttributions).where(eq(marketingAttributions.salesOrderId, campaignOrder.id));
    assert.deepEqual(attributionBefore, { campaignId: campaign.id, source: "manual" });

    await db.update(salesOrders).set({ status: "fulfilled" }).where(eq(salesOrders.id, historyOrder.id));

    assert.equal(await getAudienceCount(), audienceCountBefore + 1);
    const members = await request(`/api/marketing/customer-groups/${group.id}/members`);
    assert.equal(members.response.status, 200, JSON.stringify(members.payload));
    assert.equal(members.payload.members.length, memberCountBefore + 1);
    assert.ok(members.payload.members.some((member: { id: number }) => member.id === customer.id));
    assert.deepEqual(await getCampaignReport(), reportBeforeHistoryChange);
    const [attributionAfter] = await db.select({
      campaignId: marketingAttributions.campaignId,
      source: marketingAttributions.source,
    }).from(marketingAttributions).where(eq(marketingAttributions.salesOrderId, campaignOrder.id));
    assert.deepEqual(attributionAfter, attributionBefore);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (orderIds.length) await db.delete(marketingAttributions).where(inArray(marketingAttributions.salesOrderId, orderIds));
    if (deliveryLineId) await db.delete(salesDeliveryLines).where(eq(salesDeliveryLines.id, deliveryLineId));
    if (deliveryId) await db.delete(salesDeliveries).where(eq(salesDeliveries.id, deliveryId));
    if (orderLineIds.length) await db.delete(salesOrderLines).where(inArray(salesOrderLines.id, orderLineIds));
    if (orderIds.length) await db.delete(salesOrders).where(inArray(salesOrders.id, orderIds));
    if (campaignId) await db.delete(marketingCampaigns).where(eq(marketingCampaigns.id, campaignId));
    if (groupId) await db.delete(marketingCustomerGroups).where(eq(marketingCustomerGroups.id, groupId));
    await db.delete(businessAuditLogs).where(eq(businessAuditLogs.actorEmail, actorEmail));
    if (productId) await db.delete(products).where(eq(products.id, productId));
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
  }
});

test("marketing report counts partial campaign deliveries once and matches posted costs and expenses", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerMarketingRoutes }, { postJournal }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
    import("./accounting-posting"),
  ]);
  const requiredColumns = new Set([
    "marketing_attributions.source",
    "business_audit_logs.actor_email",
  ]);
  const availableColumns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (table_name, column_name) IN (
         ('marketing_attributions', 'source'),
         ('business_audit_logs', 'actor_email')
       )`,
  );
  for (const column of availableColumns.rows) requiredColumns.delete(`${column.table_name}.${column.column_name}`);
  if (requiredColumns.size > 0) {
    t.skip("requires the campaign attribution and business audit migrations");
    return;
  }

  const suffix = randomUUID();
  const prefix = `marketing-report-${suffix}`;
  const orderPrefix = `MKT-${suffix.slice(0, 20)}`;
  const actorEmail = `${prefix}@example.test`;
  const reportDate = "9999-12-31";
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerMarketingRoutes(app, owner);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json() as any;
    return { response, payload };
  };

  try {
    const baseline = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(baseline.response.status, 200, JSON.stringify(baseline.payload));
    assert.deepEqual(baseline.payload.period, { from: reportDate, to: reportDate });
    for (const invalidQuery of [
      "/api/marketing/reports?from=",
      "/api/marketing/reports?to=",
      `/api/marketing/reports?from=${reportDate}&from=${reportDate}`,
      `/api/marketing/reports?to=${reportDate}&to=${reportDate}`,
      "/api/marketing/reports?from=not-a-date",
      "/api/marketing/reports?from=2025-02-30",
    ]) {
      const invalid = await request(invalidQuery);
      assert.equal(invalid.response.status, 400, invalidQuery);
      assert.match(invalid.payload.error, /valid report date range/i);
    }

    const [fullyCostedCampaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} fully costed`, status: "active",
    }).returning();
    const [missingCostCampaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} missing cost`, status: "active",
    }).returning();
    const [product] = await db.insert(products).values({
      sku: `MKT-${suffix}`,
      name: `${prefix} product`,
      sellingPriceZmw: "100.00",
      status: "active",
    }).returning();
    const [customer] = await db.insert(customers).values({
      name: `${prefix} customer`,
    }).returning();

    const [fullyCostedOrder] = await db.insert(salesOrders).values({
      orderNumber: `${orderPrefix}-FULL`,
      customerId: customer.id,
      status: "partially_fulfilled",
      orderDate: reportDate,
    }).returning();
    const [fullyCostedLine] = await db.insert(salesOrderLines).values({
      salesOrderId: fullyCostedOrder.id, productId: product.id, quantity: 4, unitPriceZmw: "100.00",
    }).returning();
    const [missingCostOrder] = await db.insert(salesOrders).values({
      orderNumber: `${orderPrefix}-MISSING`,
      customerId: customer.id,
      status: "fulfilled",
      orderDate: reportDate,
    }).returning();
    const [missingCostLine] = await db.insert(salesOrderLines).values({
      salesOrderId: missingCostOrder.id, productId: product.id, quantity: 2, unitPriceZmw: "50.00",
    }).returning();

    const deliveries = [
      await db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-F1`, salesOrderId: fullyCostedOrder.id, deliveryDate: reportDate,
      }).returning(),
      await db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-F2`, salesOrderId: fullyCostedOrder.id, deliveryDate: reportDate,
      }).returning(),
      await db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-M1`, salesOrderId: missingCostOrder.id, deliveryDate: reportDate,
      }).returning(),
      await db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-M2`, salesOrderId: missingCostOrder.id, deliveryDate: reportDate,
      }).returning(),
    ];
    const [fullDeliveryOne, fullDeliveryTwo, missingDeliveryOne, missingDeliveryTwo] =
      deliveries.map(([delivery]) => delivery);
    await db.insert(salesDeliveryLines).values([
      { deliveryId: fullDeliveryOne.id, salesOrderLineId: fullyCostedLine.id, quantity: 1 },
      { deliveryId: fullDeliveryTwo.id, salesOrderLineId: fullyCostedLine.id, quantity: 2 },
      { deliveryId: missingDeliveryOne.id, salesOrderLineId: missingCostLine.id, quantity: 1 },
      { deliveryId: missingDeliveryTwo.id, salesOrderLineId: missingCostLine.id, quantity: 1 },
    ]);
    await db.insert(marketingAttributions).values([
      { salesOrderId: fullyCostedOrder.id, campaignId: fullyCostedCampaign.id, source: "manual" },
      { salesOrderId: missingCostOrder.id, campaignId: missingCostCampaign.id, source: "campaign_link" },
    ]);

    const postSaleEntry = async (
      deliveryId: number,
      kind: "revenue" | "cogs",
      amount: string,
    ) => db.transaction((tx) => postJournal(tx, {
      sourceKey: `${prefix}-${kind}-${deliveryId}`,
      sourceType: kind === "revenue" ? "sales_delivery" : "sales_delivery_cogs",
      sourceId: deliveryId,
      memo: `${prefix} ${kind} posting`,
      entryDate: reportDate,
      lines: kind === "revenue"
        ? [
          { accountKey: "accounts_receivable", debitZmw: amount },
          { accountKey: "sales_revenue", creditZmw: amount },
        ]
        : [
          { accountKey: "cost_of_goods_sold", productId: product.id, debitZmw: amount },
          { accountKey: "inventory", productId: product.id, creditZmw: amount },
        ],
    }));
    await Promise.all([
      postSaleEntry(fullDeliveryOne.id, "revenue", "100.00"),
      postSaleEntry(fullDeliveryTwo.id, "revenue", "200.00"),
      postSaleEntry(missingDeliveryOne.id, "revenue", "50.00"),
      postSaleEntry(missingDeliveryTwo.id, "revenue", "50.00"),
      postSaleEntry(fullDeliveryOne.id, "cogs", "30.00"),
      postSaleEntry(fullDeliveryTwo.id, "cogs", "60.00"),
      postSaleEntry(missingDeliveryOne.id, "cogs", "20.00"),
    ]);
    const lateAdjustmentEntry = await db.transaction((tx) => postJournal(tx, {
      sourceKey: `${prefix}-late-adjustment`,
      sourceType: "landed_cost_adjustment",
      sourceId: product.id,
      memo: `${prefix} late landed-cost adjustment`,
      entryDate: reportDate,
      lines: [
        { accountKey: "cost_of_goods_sold", productId: product.id, debitZmw: "11.01" },
        { accountKey: "inventory", productId: product.id, creditZmw: "11.01" },
      ],
    }));
    const readLateAdjustmentJournal = () => db.select({
      systemKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalEntries.id, lateAdjustmentEntry.id));
    const postedLateAdjustmentJournal = await readLateAdjustmentJournal();
    assert.deepEqual(
      postedLateAdjustmentJournal
        .map((line) => [line.systemKey, line.debitZmw, line.creditZmw])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        ["cost_of_goods_sold", "11.01", "0.00"],
        ["inventory", "0.00", "11.01"],
      ],
    );

    const campaignExpense = await request("/api/marketing/expenses", {
      campaignId: fullyCostedCampaign.id,
      category: "Advertising",
      description: `${prefix} campaign advertisement`,
      amount: "1.01",
      currency: "USD",
      exchangeRateToZmw: "7.5",
      expenseDate: reportDate,
      paid: false,
      reference: null,
      notes: null,
    });
    assert.equal(campaignExpense.response.status, 201, JSON.stringify(campaignExpense.payload));
    assert.equal(campaignExpense.payload.amountZmw, "7.58");

    const generalExpense = await request("/api/marketing/expenses", {
      campaignId: null,
      category: "Advertising",
      description: `${prefix} general advertisement`,
      amount: "2.03",
      currency: "EUR",
      exchangeRateToZmw: "8.25",
      expenseDate: reportDate,
      paid: false,
      reference: null,
      notes: null,
    });
    assert.equal(generalExpense.response.status, 201, JSON.stringify(generalExpense.payload));
    assert.equal(generalExpense.payload.amountZmw, "16.75");

    const expenseIds = [campaignExpense.payload.expense.id, generalExpense.payload.expense.id] as number[];
    const postedExpenseLines = await db.select({
      sourceId: journalEntries.sourceId,
      systemKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalEntries)
      .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(accountingAccounts, eq(accountingAccounts.id, journalLines.accountId))
      .where(and(
        eq(journalEntries.sourceType, "marketing_expense"),
        inArray(journalEntries.sourceId, expenseIds),
      ));
    assert.deepEqual(
      postedExpenseLines
        .filter((line) => line.systemKey === "marketing_expense")
        .map((line) => [line.debitZmw, line.creditZmw]).sort(),
      [["16.75", "0.00"], ["7.58", "0.00"]],
    );

    const report = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(report.response.status, 200, JSON.stringify(report.payload));
    const fullCampaign = report.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === fullyCostedCampaign.id,
    );
    const missingCampaign = report.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === missingCostCampaign.id,
    );
    assert.ok(fullCampaign);
    assert.ok(missingCampaign);
    assert.deepEqual({
      orderCount: fullCampaign.orderCount,
      attributedRevenueZmw: fullCampaign.attributedRevenueZmw,
      productCostZmw: fullCampaign.productCostZmw,
      landedCostAdjustmentZmw: fullCampaign.landedCostAdjustmentZmw,
      landedCostAdjustmentDeliveries: fullCampaign.landedCostAdjustmentDeliveries.map(
        (delivery: { deliveryNumber: string; orderNumber: string; deliveryDate: string; adjustmentZmw: string }) => ({
          deliveryNumber: delivery.deliveryNumber,
          orderNumber: delivery.orderNumber,
          deliveryDate: delivery.deliveryDate,
          adjustmentZmw: delivery.adjustmentZmw,
        }),
      ),
      spendZmw: fullCampaign.spendZmw,
      netContributionZmw: fullCampaign.netContributionZmw,
      missingCostOrders: fullCampaign.missingCostOrders,
    }, {
      orderCount: 1,
      attributedRevenueZmw: "300.00",
      productCostZmw: "99.01",
      landedCostAdjustmentZmw: "9.01",
      landedCostAdjustmentDeliveries: [
        {
          deliveryNumber: `MR-${suffix.slice(0, 12)}-F1`,
          orderNumber: fullyCostedOrder.orderNumber,
          deliveryDate: reportDate,
          adjustmentZmw: "3.00",
        },
        {
          deliveryNumber: `MR-${suffix.slice(0, 12)}-F2`,
          orderNumber: fullyCostedOrder.orderNumber,
          deliveryDate: reportDate,
          adjustmentZmw: "6.01",
        },
      ],
      spendZmw: "7.58",
      netContributionZmw: "193.41",
      missingCostOrders: [],
    });
    assert.deepEqual({
      orderCount: missingCampaign.orderCount,
      attributedRevenueZmw: missingCampaign.attributedRevenueZmw,
      productCostZmw: missingCampaign.productCostZmw,
      landedCostAdjustmentZmw: missingCampaign.landedCostAdjustmentZmw,
      landedCostAdjustmentDeliveries: missingCampaign.landedCostAdjustmentDeliveries.map(
        (delivery: { deliveryNumber: string; orderNumber: string; adjustmentZmw: string }) => ({
          deliveryNumber: delivery.deliveryNumber,
          orderNumber: delivery.orderNumber,
          adjustmentZmw: delivery.adjustmentZmw,
        }),
      ),
      netContributionZmw: missingCampaign.netContributionZmw,
      missingCostOrders: missingCampaign.missingCostOrders,
    }, {
      orderCount: 1,
      attributedRevenueZmw: "100.00",
      productCostZmw: "22.00",
      landedCostAdjustmentZmw: "2.00",
      landedCostAdjustmentDeliveries: [{
        deliveryNumber: `MR-${suffix.slice(0, 12)}-M1`,
        orderNumber: missingCostOrder.orderNumber,
        adjustmentZmw: "2.00",
      }],
      netContributionZmw: null,
      missingCostOrders: [missingCostOrder.orderNumber],
    });
    assert.equal(
      report.payload.totals.campaignLinkOrders,
      baseline.payload.totals.campaignLinkOrders + 1,
    );
    assert.equal(
      report.payload.totals.ordersWithoutCampaignLinks,
      baseline.payload.totals.ordersWithoutCampaignLinks + 1,
    );
    assert.equal(
      report.payload.totals.attributedOrders,
      baseline.payload.totals.attributedOrders + 2,
    );
    assert.ok(report.payload.ordersMissingProductCost.some(
      (order: { orderNumber: string; campaignName: string }) =>
        order.orderNumber === missingCostOrder.orderNumber
        && order.campaignName === missingCostCampaign.name,
    ));

    assert.equal(
      (BigInt(report.payload.totals.spendZmw.replace(".", "")) -
        BigInt(baseline.payload.totals.spendZmw.replace(".", ""))).toString(),
      "2433",
    );
    assert.equal(
      (BigInt(report.payload.totals.attributedRevenueZmw.replace(".", "")) -
        BigInt(baseline.payload.totals.attributedRevenueZmw.replace(".", ""))).toString(),
      "40000",
    );
    assert.equal(
      (BigInt(report.payload.totals.productCostZmw.replace(".", "")) -
        BigInt(baseline.payload.totals.productCostZmw.replace(".", ""))).toString(),
      "12101",
    );
    assert.equal(report.payload.totals.netContributionZmw, null);
    assert.equal(
      report.payload.totals.missingCostOrders,
      baseline.payload.totals.missingCostOrders + 1,
    );

    await db.transaction((tx) => postJournal(tx, {
      sourceKey: `${prefix}-cogs-${missingDeliveryTwo.id}`,
      sourceType: "sales_delivery_cogs",
      sourceId: missingDeliveryTwo.id,
      memo: `${prefix} missing delivery cost posting`,
      entryDate: reportDate,
      lines: [
        { accountKey: "cost_of_goods_sold", productId: product.id, debitZmw: "10.00" },
        { accountKey: "inventory", productId: product.id, creditZmw: "10.00" },
      ],
    }));

    const completeReport = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(completeReport.response.status, 200, JSON.stringify(completeReport.payload));
    const completeFullCampaign = completeReport.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === fullyCostedCampaign.id,
    );
    const completeMissingCampaign = completeReport.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === missingCostCampaign.id,
    );
    assert.deepEqual({
      productCostZmw: completeFullCampaign.productCostZmw,
      landedCostAdjustmentZmw: completeFullCampaign.landedCostAdjustmentZmw,
      landedCostAdjustmentDeliveries: completeFullCampaign.landedCostAdjustmentDeliveries.map(
        (delivery: { deliveryNumber: string; adjustmentZmw: string }) => [delivery.deliveryNumber, delivery.adjustmentZmw],
      ),
      netContributionZmw: completeFullCampaign.netContributionZmw,
      missingCostOrders: completeFullCampaign.missingCostOrders,
    }, {
      productCostZmw: "98.26",
      landedCostAdjustmentZmw: "8.26",
      landedCostAdjustmentDeliveries: [
        [`MR-${suffix.slice(0, 12)}-F1`, "2.75"],
        [`MR-${suffix.slice(0, 12)}-F2`, "5.51"],
      ],
      netContributionZmw: "194.16",
      missingCostOrders: [],
    });
    assert.deepEqual({
      productCostZmw: completeMissingCampaign.productCostZmw,
      landedCostAdjustmentZmw: completeMissingCampaign.landedCostAdjustmentZmw,
      landedCostAdjustmentDeliveries: completeMissingCampaign.landedCostAdjustmentDeliveries.map(
        (delivery: { deliveryNumber: string; adjustmentZmw: string }) => [delivery.deliveryNumber, delivery.adjustmentZmw],
      ),
      netContributionZmw: completeMissingCampaign.netContributionZmw,
      missingCostOrders: completeMissingCampaign.missingCostOrders,
    }, {
      productCostZmw: "32.75",
      landedCostAdjustmentZmw: "2.75",
      landedCostAdjustmentDeliveries: [
        [`MR-${suffix.slice(0, 12)}-M1`, "1.83"],
        [`MR-${suffix.slice(0, 12)}-M2`, "0.92"],
      ],
      netContributionZmw: "67.25",
      missingCostOrders: [],
    });
    assert.equal(completeReport.payload.totals.landedCostAdjustmentZmw, "11.01");
    assert.equal(
      (BigInt(completeReport.payload.totals.productCostZmw.replace(".", "")) -
        BigInt(baseline.payload.totals.productCostZmw.replace(".", ""))).toString(),
      "13101",
    );
    assert.equal(completeReport.payload.totals.netContributionZmw, "244.66");
    assert.deepEqual(await readLateAdjustmentJournal(), postedLateAdjustmentJournal);

    const crossPeriodBaseline = await request(
      "/api/marketing/reports?from=2025-01-10&to=2025-01-10",
    );
    assert.equal(crossPeriodBaseline.response.status, 200, JSON.stringify(crossPeriodBaseline.payload));

    const [crossPeriodCampaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} cross-period`, status: "active",
    }).returning();
    const [crossPeriodProduct] = await db.insert(products).values({
      sku: `MKT-${suffix}-CROSS`,
      name: `${prefix} cross-period product`,
      sellingPriceZmw: "100.00",
      status: "active",
    }).returning();
    const [crossPeriodOrder] = await db.insert(salesOrders).values({
      orderNumber: `${orderPrefix}-CROSS`,
      customerId: customer.id,
      status: "partially_fulfilled",
      orderDate: "2025-01-01",
    }).returning();
    const [crossPeriodLine] = await db.insert(salesOrderLines).values({
      salesOrderId: crossPeriodOrder.id,
      productId: crossPeriodProduct.id,
      quantity: 3,
      unitPriceZmw: "100.00",
    }).returning();
    const crossPeriodDeliveries = await Promise.all([
      db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-C1`,
        salesOrderId: crossPeriodOrder.id,
        deliveryDate: "2025-01-10",
      }).returning(),
      db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-C2`,
        salesOrderId: crossPeriodOrder.id,
        deliveryDate: "2025-01-11",
      }).returning(),
      db.insert(salesDeliveries).values({
        deliveryNumber: `MR-${suffix.slice(0, 12)}-C3`,
        salesOrderId: crossPeriodOrder.id,
        deliveryDate: "2025-01-12",
      }).returning(),
    ]);
    const [inRangeDelivery, outOfRangeCostedDelivery, outOfRangeMissingDelivery] =
      crossPeriodDeliveries.map(([delivery]) => delivery);
    await db.insert(salesDeliveryLines).values([
      { deliveryId: inRangeDelivery.id, salesOrderLineId: crossPeriodLine.id, quantity: 1 },
      { deliveryId: outOfRangeCostedDelivery.id, salesOrderLineId: crossPeriodLine.id, quantity: 1 },
      { deliveryId: outOfRangeMissingDelivery.id, salesOrderLineId: crossPeriodLine.id, quantity: 1 },
    ]);
    await db.insert(marketingAttributions).values({
      salesOrderId: crossPeriodOrder.id,
      campaignId: crossPeriodCampaign.id,
      source: "manual",
    });

    const postCrossPeriodEntry = (
      deliveryId: number,
      kind: "revenue" | "cogs",
      amount: string,
      entryDate: string,
    ) => db.transaction((tx) => postJournal(tx, {
      sourceKey: `${prefix}-cross-${kind}-${deliveryId}`,
      sourceType: kind === "revenue" ? "sales_delivery" : "sales_delivery_cogs",
      sourceId: deliveryId,
      memo: `${prefix} cross-period ${kind} posting`,
      entryDate,
      lines: kind === "revenue"
        ? [
          { accountKey: "accounts_receivable", debitZmw: amount },
          { accountKey: "sales_revenue", creditZmw: amount },
        ]
        : [
          { accountKey: "cost_of_goods_sold", productId: crossPeriodProduct.id, debitZmw: amount },
          { accountKey: "inventory", productId: crossPeriodProduct.id, creditZmw: amount },
        ],
    }));
    await Promise.all([
      postCrossPeriodEntry(inRangeDelivery.id, "revenue", "100.00", "2025-01-10"),
      postCrossPeriodEntry(outOfRangeCostedDelivery.id, "revenue", "100.00", "2025-01-11"),
      postCrossPeriodEntry(outOfRangeMissingDelivery.id, "revenue", "100.00", "2025-01-12"),
      postCrossPeriodEntry(inRangeDelivery.id, "cogs", "10.00", "2025-02-01"),
      postCrossPeriodEntry(outOfRangeCostedDelivery.id, "cogs", "30.00", "2025-01-05"),
      db.transaction((tx) => postJournal(tx, {
        sourceKey: `${prefix}-cross-late-adjustment`,
        sourceType: "landed_cost_adjustment",
        sourceId: crossPeriodProduct.id,
        memo: `${prefix} cross-period landed-cost adjustment`,
        entryDate: "2025-02-02",
        lines: [
          { accountKey: "cost_of_goods_sold", productId: crossPeriodProduct.id, debitZmw: "20.00" },
          { accountKey: "inventory", productId: crossPeriodProduct.id, creditZmw: "20.00" },
        ],
      })),
    ]);

    const [returnedMovement] = await db.insert(inventoryMovements).values({
      productId: crossPeriodProduct.id,
      kind: "stock_return",
      quantityDelta: 1,
      reason: `${prefix} campaign report test return`,
      reference: inRangeDelivery.deliveryNumber,
      sourceKey: `${prefix}-return-movement`,
      salesDeliveryLineId: (await db.select({ id: salesDeliveryLines.id })
        .from(salesDeliveryLines)
        .where(eq(salesDeliveryLines.deliveryId, inRangeDelivery.id))
        .limit(1))[0].id,
    }).returning();
    await Promise.all([
      db.transaction((tx) => postJournal(tx, {
        sourceKey: `${prefix}-return-revenue`,
        sourceType: "sales_return",
        sourceId: returnedMovement.id,
        memo: `${prefix} campaign report return revenue reversal`,
        entryDate: "2025-01-13",
        lines: [
          { accountKey: "sales_revenue", debitZmw: "100.00" },
          { accountKey: "accounts_receivable", creditZmw: "100.00" },
        ],
      })),
      db.transaction((tx) => postJournal(tx, {
        sourceKey: `${prefix}-return-cogs`,
        sourceType: "sales_return_cogs",
        sourceId: returnedMovement.id,
        memo: `${prefix} campaign report return cost reversal`,
        entryDate: "2025-01-13",
        lines: [
          { accountKey: "inventory", productId: crossPeriodProduct.id, debitZmw: "10.00" },
          { accountKey: "cost_of_goods_sold", productId: crossPeriodProduct.id, creditZmw: "10.00" },
        ],
      })),
    ]);

    const crossPeriodReport = await request(
      "/api/marketing/reports?from=2025-01-10&to=2025-01-10",
    );
    assert.equal(crossPeriodReport.response.status, 200, JSON.stringify(crossPeriodReport.payload));
    const crossPeriodCampaignReport = crossPeriodReport.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === crossPeriodCampaign.id,
    );
    assert.deepEqual({
      orderCount: crossPeriodCampaignReport.orderCount,
      attributedRevenueZmw: crossPeriodCampaignReport.attributedRevenueZmw,
      productCostZmw: crossPeriodCampaignReport.productCostZmw,
      landedCostAdjustmentZmw: crossPeriodCampaignReport.landedCostAdjustmentZmw,
      landedCostAdjustmentDeliveries: crossPeriodCampaignReport.landedCostAdjustmentDeliveries.map(
        (delivery: { deliveryDate: string; adjustmentZmw: string }) => [delivery.deliveryDate, delivery.adjustmentZmw],
      ),
      netContributionZmw: crossPeriodCampaignReport.netContributionZmw,
      missingCostOrders: crossPeriodCampaignReport.missingCostOrders,
    }, {
      orderCount: 1,
      attributedRevenueZmw: "100.00",
      productCostZmw: "15.00",
      landedCostAdjustmentZmw: "5.00",
      landedCostAdjustmentDeliveries: [["2025-01-10", "5.00"]],
      netContributionZmw: "85.00",
      missingCostOrders: [],
    });

    const centsDelta = (current: string, baselineValue: string) =>
      (BigInt(current.replace(".", "")) - BigInt(baselineValue.replace(".", ""))).toString();
    assert.equal(
      centsDelta(crossPeriodReport.payload.totals.attributedRevenueZmw, crossPeriodBaseline.payload.totals.attributedRevenueZmw),
      "10000",
    );
    assert.equal(
      centsDelta(crossPeriodReport.payload.totals.productCostZmw, crossPeriodBaseline.payload.totals.productCostZmw),
      "1500",
    );
    assert.equal(
      centsDelta(crossPeriodReport.payload.totals.landedCostAdjustmentZmw, crossPeriodBaseline.payload.totals.landedCostAdjustmentZmw),
      "500",
    );
    assert.equal(
      crossPeriodReport.payload.totals.missingCostOrders,
      crossPeriodBaseline.payload.totals.missingCostOrders,
    );
    assert.equal(
      crossPeriodReport.payload.totals.netContributionZmw === null
        ? null
        : crossPeriodBaseline.payload.totals.netContributionZmw === null
          ? "unexpected non-null total"
          : centsDelta(
            crossPeriodReport.payload.totals.netContributionZmw,
            crossPeriodBaseline.payload.totals.netContributionZmw,
          ),
      crossPeriodBaseline.payload.totals.netContributionZmw === null ? null : "8500",
    );
    assert.equal(
      BigInt(centsDelta(
        crossPeriodReport.payload.totals.attributedRevenueZmw,
        crossPeriodBaseline.payload.totals.attributedRevenueZmw,
      ))
        - BigInt(centsDelta(
          crossPeriodReport.payload.totals.productCostZmw,
          crossPeriodBaseline.payload.totals.productCostZmw,
        )),
      8500n,
    );

    const returnDateReport = await request(
      "/api/marketing/reports?from=2025-01-13&to=2025-01-13",
    );
    assert.equal(returnDateReport.response.status, 200, JSON.stringify(returnDateReport.payload));
    const returnDateCampaign = returnDateReport.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === crossPeriodCampaign.id,
    );
    assert.deepEqual({
      orderCount: returnDateCampaign.orderCount,
      attributedRevenueZmw: returnDateCampaign.attributedRevenueZmw,
      productCostZmw: returnDateCampaign.productCostZmw,
      netContributionZmw: returnDateCampaign.netContributionZmw,
    }, {
      orderCount: 1,
      attributedRevenueZmw: "-100.00",
      productCostZmw: "-10.00",
      netContributionZmw: "-90.00",
    });
    assert.equal(returnDateReport.payload.totals.attributedRevenueZmw, "-100.00");
    assert.equal(returnDateReport.payload.totals.productCostZmw, "-10.00");

    const linkReturnDate = "2025-01-14";
    const linkReturnBaseline = await request(
      `/api/marketing/reports?from=${linkReturnDate}&to=${linkReturnDate}`,
    );
    const [linkReturnOrder] = await db.insert(salesOrders).values({
      orderNumber: `${orderPrefix}-LINKRETURN`,
      customerId: customer.id,
      status: "partially_fulfilled",
      orderDate: "2025-01-01",
    }).returning();
    const [linkReturnLine] = await db.insert(salesOrderLines).values({
      salesOrderId: linkReturnOrder.id,
      productId: crossPeriodProduct.id,
      quantity: 1,
      unitPriceZmw: "40.00",
    }).returning();
    const [linkReturnDelivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `MR-${suffix.slice(0, 12)}-LR`,
      salesOrderId: linkReturnOrder.id,
      deliveryDate: "2025-01-10",
    }).returning();
    const [linkReturnDeliveryLine] = await db.insert(salesDeliveryLines).values({
      deliveryId: linkReturnDelivery.id,
      salesOrderLineId: linkReturnLine.id,
      quantity: 1,
    }).returning();
    await db.insert(marketingAttributions).values({
      salesOrderId: linkReturnOrder.id,
      campaignId: crossPeriodCampaign.id,
      source: "campaign_link",
    });
    const [savedLinkReturnAttribution] = await db.select({
      campaignId: marketingAttributions.campaignId,
      source: marketingAttributions.source,
    }).from(marketingAttributions).where(eq(marketingAttributions.salesOrderId, linkReturnOrder.id));
    assert.deepEqual(savedLinkReturnAttribution, {
      campaignId: crossPeriodCampaign.id,
      source: "campaign_link",
    });
    await Promise.all([
      postCrossPeriodEntry(linkReturnDelivery.id, "revenue", "40.00", "2025-01-10"),
      postCrossPeriodEntry(linkReturnDelivery.id, "cogs", "4.00", "2025-01-10"),
    ]);
    const [linkReturnMovement] = await db.insert(inventoryMovements).values({
      productId: crossPeriodProduct.id,
      kind: "stock_return",
      quantityDelta: 1,
      reason: `${prefix} campaign-link return`,
      reference: linkReturnDelivery.deliveryNumber,
      sourceKey: `${prefix}-return-link-movement`,
      salesDeliveryLineId: linkReturnDeliveryLine.id,
    }).returning();
    await Promise.all([
      db.transaction((tx) => postJournal(tx, {
        sourceKey: `${prefix}-return-link-revenue`,
        sourceType: "sales_return",
        sourceId: linkReturnMovement.id,
        memo: `${prefix} campaign-link return revenue reversal`,
        entryDate: linkReturnDate,
        lines: [
          { accountKey: "sales_revenue", debitZmw: "40.00" },
          { accountKey: "accounts_receivable", creditZmw: "40.00" },
        ],
      })),
      db.transaction((tx) => postJournal(tx, {
        sourceKey: `${prefix}-return-link-cogs`,
        sourceType: "sales_return_cogs",
        sourceId: linkReturnMovement.id,
        memo: `${prefix} campaign-link return cost reversal`,
        entryDate: linkReturnDate,
        lines: [
          { accountKey: "inventory", productId: crossPeriodProduct.id, debitZmw: "4.00" },
          { accountKey: "cost_of_goods_sold", productId: crossPeriodProduct.id, creditZmw: "4.00" },
        ],
      })),
    ]);
    const linkReturnReport = await request(
      `/api/marketing/reports?from=${linkReturnDate}&to=${linkReturnDate}`,
    );
    assert.equal(linkReturnReport.response.status, 200, JSON.stringify(linkReturnReport.payload));
    const linkReturnCampaign = linkReturnReport.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === crossPeriodCampaign.id,
    );
    assert.deepEqual({
      orderCount: linkReturnCampaign.orderCount,
      attributedRevenueZmw: linkReturnCampaign.attributedRevenueZmw,
      productCostZmw: linkReturnCampaign.productCostZmw,
      netContributionZmw: linkReturnCampaign.netContributionZmw,
    }, {
      orderCount: 1,
      attributedRevenueZmw: "-40.00",
      productCostZmw: "-4.00",
      netContributionZmw: "-36.00",
    });
    assert.equal(
      linkReturnReport.payload.totals.campaignLinkOrders,
      linkReturnBaseline.payload.totals.campaignLinkOrders + 1,
    );
    assert.equal(
      linkReturnReport.payload.totals.ordersWithoutCampaignLinks,
      linkReturnBaseline.payload.totals.ordersWithoutCampaignLinks,
    );

    const fullRangeBeforeReversal = await request(
      "/api/marketing/reports?from=2025-01-10&to=2025-01-11",
    );
    const beforeReversalCampaign = fullRangeBeforeReversal.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === crossPeriodCampaign.id,
    );
    const reversalEntry = await db.transaction((tx) => postJournal(tx, {
      sourceKey: `${prefix}-cross-negative-adjustment`,
      sourceType: "landed_cost_adjustment",
      sourceId: crossPeriodProduct.id,
      memo: `${prefix} cross-period landed-cost reversal`,
      entryDate: "2025-02-01",
      lines: [
        { accountKey: "inventory", productId: crossPeriodProduct.id, debitZmw: "1.01" },
        { accountKey: "cost_of_goods_sold", productId: crossPeriodProduct.id, creditZmw: "1.01" },
      ],
    }));
    const readReversalJournal = () => db.select({
      systemKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalEntries.id, reversalEntry.id));
    const sourceReversalJournal = await readReversalJournal();
    assert.deepEqual(
      sourceReversalJournal
        .map((line) => [line.systemKey, line.debitZmw, line.creditZmw])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        ["cost_of_goods_sold", "0.00", "1.01"],
        ["inventory", "1.01", "0.00"],
      ],
    );

    const jan10AfterReversal = await request(
      "/api/marketing/reports?from=2025-01-10&to=2025-01-10",
    );
    const jan11AfterReversal = await request(
      "/api/marketing/reports?from=2025-01-11&to=2025-01-11",
    );
    const fullRangeAfterReversal = await request(
      "/api/marketing/reports?from=2025-01-10&to=2025-01-11",
    );
    const jan10Campaign = jan10AfterReversal.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === crossPeriodCampaign.id,
    );
    const jan11Campaign = jan11AfterReversal.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === crossPeriodCampaign.id,
    );
    const fullRangeCampaign = fullRangeAfterReversal.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === crossPeriodCampaign.id,
    );
    assert.deepEqual({
      jan10: [
        jan10Campaign.productCostZmw,
        jan10Campaign.landedCostAdjustmentZmw,
        jan10Campaign.netContributionZmw,
        jan10Campaign.attributedRevenueZmw,
      ],
      jan11: [
        jan11Campaign.productCostZmw,
        jan11Campaign.landedCostAdjustmentZmw,
        jan11Campaign.netContributionZmw,
        jan11Campaign.attributedRevenueZmw,
      ],
      combined: [
        fullRangeCampaign.productCostZmw,
        fullRangeCampaign.landedCostAdjustmentZmw,
        fullRangeCampaign.netContributionZmw,
      ],
    }, {
      jan10: ["20.04", "6.04", "119.96", "140.00"],
      jan11: ["42.95", "12.95", "57.05", "100.00"],
      combined: ["62.99", "18.99", "177.01"],
    });
    assert.equal(
      centsDelta(fullRangeAfterReversal.payload.totals.productCostZmw, fullRangeBeforeReversal.payload.totals.productCostZmw),
      "-101",
    );
    assert.equal(
      centsDelta(fullRangeAfterReversal.payload.totals.landedCostAdjustmentZmw, fullRangeBeforeReversal.payload.totals.landedCostAdjustmentZmw),
      "-101",
    );
    assert.equal(centsDelta(fullRangeCampaign.netContributionZmw, beforeReversalCampaign.netContributionZmw), "101");
    assert.equal(
      centsDelta(jan10Campaign.productCostZmw, fullRangeCampaign.productCostZmw),
      "-4295",
    );
    assert.equal(
      centsDelta(jan11Campaign.productCostZmw, fullRangeCampaign.productCostZmw),
      "-2004",
    );
    assert.equal(
      BigInt(jan10Campaign.attributedRevenueZmw.replace(".", ""))
        + BigInt(jan11Campaign.attributedRevenueZmw.replace(".", "")),
      BigInt(fullRangeCampaign.attributedRevenueZmw.replace(".", "")),
    );
    assert.equal(
      BigInt(jan10Campaign.productCostZmw.replace(".", ""))
        + BigInt(jan11Campaign.productCostZmw.replace(".", "")),
      BigInt(fullRangeCampaign.productCostZmw.replace(".", "")),
    );
    assert.equal(
      BigInt(jan10Campaign.landedCostAdjustmentZmw.replace(".", ""))
        + BigInt(jan11Campaign.landedCostAdjustmentZmw.replace(".", "")),
      BigInt(fullRangeCampaign.landedCostAdjustmentZmw.replace(".", "")),
    );
    assert.deepEqual(await readReversalJournal(), sourceReversalJournal);

    const [breakdownProductA, breakdownProductB] = await db.insert(products).values([
      {
        sku: `MKT-${suffix}-PDA`,
        name: `${prefix} breakdown product A`,
        sellingPriceZmw: "100.00",
        status: "active",
      },
      {
        sku: `MKT-${suffix}-PDB`,
        name: `${prefix} breakdown product B`,
        sellingPriceZmw: "200.00",
        status: "active",
      },
    ]).returning();
    const [breakdownOrder] = await db.insert(salesOrders).values({
      orderNumber: `${orderPrefix}-BREAKDOWN`,
      customerId: customer.id,
      status: "partially_fulfilled",
      orderDate: "2025-02-02",
    }).returning();
    const [breakdownLineA, breakdownLineB] = await db.insert(salesOrderLines).values([
      { salesOrderId: breakdownOrder.id, productId: breakdownProductA.id, quantity: 1, unitPriceZmw: "100.00" },
      { salesOrderId: breakdownOrder.id, productId: breakdownProductB.id, quantity: 1, unitPriceZmw: "200.00" },
    ]).returning();
    const [breakdownDelivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `MR-${suffix.slice(0, 12)}-BD`,
      salesOrderId: breakdownOrder.id,
      deliveryDate: "2025-02-02",
    }).returning();
    await db.insert(salesDeliveryLines).values([
      { deliveryId: breakdownDelivery.id, salesOrderLineId: breakdownLineA.id, quantity: 1 },
      { deliveryId: breakdownDelivery.id, salesOrderLineId: breakdownLineB.id, quantity: 1 },
    ]);
    await db.insert(marketingAttributions).values({
      salesOrderId: breakdownOrder.id,
      campaignId: crossPeriodCampaign.id,
      source: "manual",
    });
    await db.transaction((tx) => postJournal(tx, {
      sourceKey: `${prefix}-breakdown-revenue`,
      sourceType: "sales_delivery",
      sourceId: breakdownDelivery.id,
      memo: `${prefix} product breakdown revenue`,
      entryDate: "2025-02-02",
      lines: [
        { accountKey: "accounts_receivable", debitZmw: "300.00" },
        { accountKey: "sales_revenue", creditZmw: "300.00" },
      ],
    }));
    await db.transaction((tx) => postJournal(tx, {
      sourceKey: `${prefix}-breakdown-cogs`,
      sourceType: "sales_delivery_cogs",
      sourceId: breakdownDelivery.id,
      memo: `${prefix} product breakdown cost`,
      entryDate: "2025-02-02",
      lines: [
        { accountKey: "cost_of_goods_sold", productId: breakdownProductA.id, debitZmw: "10.00" },
        { accountKey: "inventory", productId: breakdownProductA.id, creditZmw: "10.00" },
        { accountKey: "cost_of_goods_sold", productId: breakdownProductB.id, debitZmw: "20.00" },
        { accountKey: "inventory", productId: breakdownProductB.id, creditZmw: "20.00" },
      ],
    }));
    for (const [product, amount] of [[breakdownProductA, "1.01"], [breakdownProductB, "2.03"]] as const) {
      await db.transaction((tx) => postJournal(tx, {
        sourceKey: `${prefix}-breakdown-adjustment-${product.id}`,
        sourceType: "landed_cost_adjustment",
        sourceId: product.id,
        memo: `${prefix} product breakdown landed cost`,
        entryDate: "2025-02-02",
        lines: [
          { accountKey: "cost_of_goods_sold", productId: product.id, debitZmw: amount },
          { accountKey: "inventory", productId: product.id, creditZmw: amount },
        ],
      }));
    }
    const breakdownReport = await request(
      "/api/marketing/reports?from=2025-02-02&to=2025-02-02",
    );
    const breakdownCampaign = breakdownReport.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === crossPeriodCampaign.id,
    );
    const breakdownDetails = breakdownCampaign.landedCostAdjustmentDeliveries.find(
      (delivery: { deliveryId: number }) => delivery.deliveryId === breakdownDelivery.id,
    );
    assert.deepEqual({
      revenue: breakdownCampaign.attributedRevenueZmw,
      productCost: breakdownCampaign.productCostZmw,
      adjustment: breakdownCampaign.landedCostAdjustmentZmw,
      contribution: breakdownCampaign.netContributionZmw,
      deliveryAdjustment: breakdownDetails.adjustmentZmw,
      productShares: breakdownDetails.products.map(
        (product: { productName: string; adjustmentZmw: string }) => [product.productName, product.adjustmentZmw],
      ),
    }, {
      revenue: "300.00",
      productCost: "33.04",
      adjustment: "3.04",
      contribution: "266.96",
      deliveryAdjustment: "3.04",
      productShares: [
        [`${prefix} breakdown product A`, "1.01"],
        [`${prefix} breakdown product B`, "2.03"],
      ],
    });
    assert.equal(
      breakdownDetails.products.reduce(
        (total: bigint, product: { adjustmentZmw: string }) => total + BigInt(product.adjustmentZmw.replace(".", "")),
        0n,
      ),
      BigInt(breakdownDetails.adjustmentZmw.replace(".", "")),
    );

    const [unallocatedCampaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} unallocated`, status: "active",
    }).returning();
    const [unallocatedProduct] = await db.insert(products).values({
      sku: `MKT-${suffix}-UNALLOCATED`,
      name: `${prefix} unallocated product`,
      sellingPriceZmw: "50.00",
      status: "active",
    }).returning();
    const [unallocatedOrder] = await db.insert(salesOrders).values({
      orderNumber: `${orderPrefix}-UNCOSTED`,
      customerId: customer.id,
      status: "partially_fulfilled",
      orderDate: "2025-02-03",
    }).returning();
    const [unallocatedLine] = await db.insert(salesOrderLines).values({
      salesOrderId: unallocatedOrder.id,
      productId: unallocatedProduct.id,
      quantity: 1,
      unitPriceZmw: "50.00",
    }).returning();
    const [unallocatedDelivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `MR-${suffix.slice(0, 12)}-UC`,
      salesOrderId: unallocatedOrder.id,
      deliveryDate: "2025-02-03",
    }).returning();
    await db.insert(salesDeliveryLines).values({
      deliveryId: unallocatedDelivery.id,
      salesOrderLineId: unallocatedLine.id,
      quantity: 1,
    });
    await db.insert(marketingAttributions).values({
      salesOrderId: unallocatedOrder.id,
      campaignId: unallocatedCampaign.id,
      source: "manual",
    });
    await db.transaction((tx) => postJournal(tx, {
      sourceKey: `${prefix}-unallocated-adjustment`,
      sourceType: "landed_cost_adjustment",
      sourceId: unallocatedProduct.id,
      memo: `${prefix} unallocated landed cost`,
      entryDate: "2025-02-03",
      lines: [
        { accountKey: "cost_of_goods_sold", productId: unallocatedProduct.id, debitZmw: "5.00" },
        { accountKey: "inventory", productId: unallocatedProduct.id, creditZmw: "5.00" },
      ],
    }));
    const unallocatedReport = await request(
      "/api/marketing/reports?from=2025-02-03&to=2025-02-03",
    );
    const unallocatedCampaignReport = unallocatedReport.payload.campaigns.find(
      (campaign: { id: number }) => campaign.id === unallocatedCampaign.id,
    );
    const unallocatedCorrection = unallocatedReport.payload.unallocatedLandedCostAdjustments.find(
      (item: { productId: number }) => item.productId === unallocatedProduct.id,
    );
    assert.equal(unallocatedCampaignReport.productCostZmw, "0.00");
    assert.equal(unallocatedCampaignReport.landedCostAdjustmentZmw, "0.00");
    assert.equal(unallocatedCampaignReport.netContributionZmw, null);
    assert.deepEqual(unallocatedCorrection, {
      productId: unallocatedProduct.id,
      productName: unallocatedProduct.name,
      adjustmentZmw: "5.00",
      campaignNames: [unallocatedCampaign.name],
    });
    assert.equal(unallocatedReport.payload.totals.unallocatedLandedCostAdjustmentZmw, "5.00");
    assert.equal(unallocatedReport.payload.totals.netContributionZmw, null);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM journal_lines WHERE journal_entry_id IN (
          SELECT id FROM journal_entries WHERE source_key LIKE $1
        )`,
        [`${prefix}-%`],
      );
      await client.query("DELETE FROM journal_entries WHERE source_key LIKE $1", [`${prefix}-%`]);
      await client.query("DELETE FROM inventory_movements WHERE source_key LIKE $1", [`${prefix}-return-%`]);
      await client.query(
        `DELETE FROM journal_lines WHERE journal_entry_id IN (
          SELECT id FROM journal_entries
          WHERE source_type = 'marketing_expense'
            AND source_id IN (SELECT id FROM marketing_expenses WHERE description LIKE $1)
        )`,
        [`${prefix}%`],
      );
      await client.query(
        `DELETE FROM journal_entries
         WHERE source_type = 'marketing_expense'
           AND source_id IN (SELECT id FROM marketing_expenses WHERE description LIKE $1)`,
        [`${prefix}%`],
      );
      await client.query(
        `DELETE FROM business_audit_logs WHERE actor_email = $1`,
        [actorEmail],
      );
      await client.query(
        `DELETE FROM marketing_expenses WHERE description LIKE $1`,
        [`${prefix}%`],
      );
      await client.query(
        `DELETE FROM marketing_attributions WHERE sales_order_id IN (
          SELECT id FROM sales_orders WHERE order_number LIKE $1
        )`,
        [`${orderPrefix}-%`],
      );
      await client.query(
        `DELETE FROM sales_delivery_lines WHERE delivery_id IN (
          SELECT id FROM sales_deliveries WHERE sales_order_id IN (
            SELECT id FROM sales_orders WHERE order_number LIKE $1
          )
        )`,
        [`${orderPrefix}-%`],
      );
      await client.query(
        `DELETE FROM sales_deliveries WHERE sales_order_id IN (
          SELECT id FROM sales_orders WHERE order_number LIKE $1
        )`,
        [`${orderPrefix}-%`],
      );
      await client.query(
        `DELETE FROM sales_order_lines WHERE sales_order_id IN (
          SELECT id FROM sales_orders WHERE order_number LIKE $1
        )`,
        [`${orderPrefix}-%`],
      );
      await client.query("DELETE FROM sales_orders WHERE order_number LIKE $1", [`${orderPrefix}-%`]);
      await client.query("DELETE FROM marketing_campaigns WHERE name LIKE $1", [`${prefix}%`]);
      await client.query("DELETE FROM customers WHERE name = $1", [`${prefix} customer`]);
      await client.query("DELETE FROM products WHERE sku LIKE $1", [`MKT-${suffix}%`]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});

test("campaign reports show negative delivery shares for reversed landed costs", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerMarketingRoutes }, { postJournal }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
    import("./accounting-posting"),
  ]);
  const availableColumns = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'marketing_attributions'
       AND column_name = 'source'`,
  );
  if (availableColumns.rows.length === 0) {
    t.skip("requires the campaign attribution source migration");
    return;
  }

  const suffix = randomUUID();
  const prefix = `negative-landed-cost-${suffix}`;
  const actorEmail = `${prefix}@example.test`;
  const reportDate = "9999-12-30";
  const nextReportDate = "9999-12-31";
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerMarketingRoutes(app, owner);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const requestReport = async (from = reportDate, to = nextReportDate) => {
    const response = await fetch(`${baseUrl}/api/marketing/reports?from=${from}&to=${to}`);
    return { response, payload: await response.json() as any };
  };
  let customerId: number | undefined;
  let productId: number | undefined;
  let campaignId: number | undefined;
  let orderId: number | undefined;
  const orderLineIds: number[] = [];
  const deliveryIds: number[] = [];
  const deliveryLineIds: number[] = [];
  const journalEntryIds: number[] = [];

  try {
    const [campaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} campaign`,
      status: "active",
    }).returning();
    campaignId = campaign.id;
    const [customer] = await db.insert(customers).values({
      name: `${prefix} customer`,
    }).returning();
    customerId = customer.id;
    const [product] = await db.insert(products).values({
      sku: `NLC-${suffix}`,
      name: `${prefix} product`,
      sellingPriceZmw: "100.00",
      status: "active",
    }).returning();
    productId = product.id;
    const [order] = await db.insert(salesOrders).values({
      orderNumber: `NLC-${suffix.slice(0, 20)}-1`,
      customerId: customer.id,
      status: "fulfilled",
      orderDate: reportDate,
    }).returning();
    orderId = order.id;
    const [line] = await db.insert(salesOrderLines).values({
      salesOrderId: order.id,
      productId: product.id,
      quantity: 4,
      unitPriceZmw: "100.00",
    }).returning();
    orderLineIds.push(line.id);
    const deliveries = await db.insert(salesDeliveries).values([
      { deliveryNumber: `NLC-${suffix.slice(0, 16)}-D1`, salesOrderId: order.id, deliveryDate: reportDate },
      { deliveryNumber: `NLC-${suffix.slice(0, 16)}-D2`, salesOrderId: order.id, deliveryDate: nextReportDate },
    ]).returning();
    deliveryIds.push(...deliveries.map((delivery) => delivery.id));
    const deliveryLines = await db.insert(salesDeliveryLines).values([
      { deliveryId: deliveries[0]!.id, salesOrderLineId: line.id, quantity: 1 },
      { deliveryId: deliveries[1]!.id, salesOrderLineId: line.id, quantity: 3 },
    ]).returning();
    deliveryLineIds.push(...deliveryLines.map((deliveryLine) => deliveryLine.id));
    await db.insert(marketingAttributions).values({
      salesOrderId: order.id,
      campaignId: campaign.id,
      source: "manual",
    });

    for (const [index, delivery] of deliveries.entries()) {
      const amount = index === 0 ? "10.00" : "30.00";
      const entry = await db.transaction((tx) => postJournal(tx, {
        sourceKey: `${prefix}-delivery-cogs-${delivery.id}`,
        sourceType: "sales_delivery_cogs",
        sourceId: delivery.id,
        memo: `${prefix} delivery cost`,
        entryDate: delivery.deliveryDate,
        lines: [
          { accountKey: "cost_of_goods_sold", productId: product.id, debitZmw: amount },
          { accountKey: "inventory", productId: product.id, creditZmw: amount },
        ],
      }));
      journalEntryIds.push(entry.id);
    }

    const baseline = await requestReport();
    assert.equal(baseline.response.status, 200, JSON.stringify(baseline.payload));
    const baselineCampaign = baseline.payload.campaigns.find((item: { id: number }) => item.id === campaign.id);
    assert.ok(baselineCampaign);
    assert.equal(baselineCampaign.productCostZmw, "40.00");
    assert.equal(baselineCampaign.landedCostAdjustmentZmw, "0.00");
    assert.equal(baseline.payload.totals.productCostZmw, "40.00");
    assert.equal(baseline.payload.totals.landedCostAdjustmentZmw, "0.00");
    assert.equal(baseline.payload.totals.netContributionZmw, "360.00");

    const reversal = await db.transaction((tx) => postJournal(tx, {
      sourceKey: `${prefix}-landed-cost-reversal`,
      sourceType: "landed_cost_adjustment",
      sourceId: product.id,
      memo: `${prefix} landed-cost reversal`,
      entryDate: nextReportDate,
      lines: [
        { accountKey: "inventory", productId: product.id, debitZmw: "0.05" },
        { accountKey: "cost_of_goods_sold", productId: product.id, creditZmw: "0.05" },
      ],
    }));
    journalEntryIds.push(reversal.id);
    const readReversalJournal = () => db.select({
      systemKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalEntries.id, reversal.id));
    const sourceJournal = await readReversalJournal();
    const firstPeriod = await requestReport(reportDate, reportDate);
    const secondPeriod = await requestReport(nextReportDate, nextReportDate);
    const report = await requestReport();
    assert.equal(report.response.status, 200, JSON.stringify(report.payload));
    assert.equal(firstPeriod.response.status, 200, JSON.stringify(firstPeriod.payload));
    assert.equal(secondPeriod.response.status, 200, JSON.stringify(secondPeriod.payload));
    const campaignReport = report.payload.campaigns.find((item: { id: number }) => item.id === campaign.id);
    const firstPeriodCampaign = firstPeriod.payload.campaigns.find((item: { id: number }) => item.id === campaign.id);
    const secondPeriodCampaign = secondPeriod.payload.campaigns.find((item: { id: number }) => item.id === campaign.id);
    assert.ok(campaignReport);
    assert.ok(firstPeriodCampaign);
    assert.ok(secondPeriodCampaign);
    assert.equal(campaignReport.orderCount, 1);
    assert.equal(campaignReport.attributedRevenueZmw, "400.00");
    assert.equal(campaignReport.productCostZmw, "39.95");
    assert.equal(campaignReport.landedCostAdjustmentZmw, "-0.05");
    assert.equal(campaignReport.netContributionZmw, "360.05");
    assert.equal(report.payload.totals.productCostZmw, "39.95");
    assert.equal(report.payload.totals.landedCostAdjustmentZmw, "-0.05");
    assert.equal(report.payload.totals.netContributionZmw, "360.05");
    assert.deepEqual(
      campaignReport.landedCostAdjustmentDeliveries.map((delivery: {
        deliveryNumber: string;
        adjustmentZmw: string;
        products: { productId: number; adjustmentZmw: string }[];
      }) => [
        delivery.deliveryNumber,
        delivery.adjustmentZmw,
        delivery.products.map((item) => [item.productId, item.adjustmentZmw]),
      ]),
      [
        [`NLC-${suffix.slice(0, 16)}-D1`, "-0.01", [[product.id, "-0.01"]]],
        [`NLC-${suffix.slice(0, 16)}-D2`, "-0.04", [[product.id, "-0.04"]]],
      ],
    );
    assert.deepEqual({
      firstPeriod: [
        firstPeriodCampaign.attributedRevenueZmw,
        firstPeriodCampaign.productCostZmw,
        firstPeriodCampaign.landedCostAdjustmentZmw,
        firstPeriodCampaign.netContributionZmw,
      ],
      secondPeriod: [
        secondPeriodCampaign.attributedRevenueZmw,
        secondPeriodCampaign.productCostZmw,
        secondPeriodCampaign.landedCostAdjustmentZmw,
        secondPeriodCampaign.netContributionZmw,
      ],
    }, {
      firstPeriod: ["100.00", "9.99", "-0.01", "90.01"],
      secondPeriod: ["300.00", "29.96", "-0.04", "270.04"],
    });
    for (const field of ["attributedRevenueZmw", "productCostZmw", "landedCostAdjustmentZmw", "netContributionZmw"] as const) {
      assert.equal(
        BigInt(firstPeriodCampaign[field].replace(".", ""))
          + BigInt(secondPeriodCampaign[field].replace(".", "")),
        BigInt(campaignReport[field].replace(".", "")),
        `${field} from the adjacent periods must equal the combined report`,
      );
    }
    const allocatedCents = campaignReport.landedCostAdjustmentDeliveries
      .flatMap((delivery: { adjustmentZmw: string }) => [BigInt(delivery.adjustmentZmw.replace(".", ""))])
      .reduce((total: bigint, amount: bigint) => total + amount, 0n);
    const postedCogsAdjustmentCents = sourceJournal
      .filter((line) => line.systemKey === "cost_of_goods_sold")
      .reduce((total, line) =>
        total + BigInt(line.debitZmw.replace(".", "")) - BigInt(line.creditZmw.replace(".", "")), 0n);
    assert.equal(allocatedCents, postedCogsAdjustmentCents);
    assert.equal(allocatedCents, -5n);
    assert.equal(
      BigInt(campaignReport.productCostZmw.replace(".", ""))
        - BigInt(baselineCampaign.productCostZmw.replace(".", "")),
      allocatedCents,
    );
    assert.equal(
      BigInt(report.payload.totals.productCostZmw.replace(".", ""))
        - BigInt(baseline.payload.totals.productCostZmw.replace(".", "")),
      -5n,
    );
    assert.equal(
      BigInt(report.payload.totals.netContributionZmw.replace(".", ""))
        - BigInt(baseline.payload.totals.netContributionZmw.replace(".", "")),
      5n,
    );
    assert.deepEqual(await readReversalJournal(), sourceJournal);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (orderId) await db.delete(marketingAttributions).where(eq(marketingAttributions.salesOrderId, orderId));
    if (journalEntryIds.length) {
      await db.delete(journalLines).where(inArray(journalLines.journalEntryId, journalEntryIds));
      await db.delete(journalEntries).where(inArray(journalEntries.id, journalEntryIds));
    }
    if (deliveryLineIds.length) await db.delete(salesDeliveryLines).where(inArray(salesDeliveryLines.id, deliveryLineIds));
    if (deliveryIds.length) await db.delete(salesDeliveries).where(inArray(salesDeliveries.id, deliveryIds));
    if (orderLineIds.length) await db.delete(salesOrderLines).where(inArray(salesOrderLines.id, orderLineIds));
    if (orderId) await db.delete(salesOrders).where(eq(salesOrders.id, orderId));
    if (campaignId) await db.delete(marketingCampaigns).where(eq(marketingCampaigns.id, campaignId));
    if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
    if (productId) await db.delete(products).where(eq(products.id, productId));
    await db.delete(businessAuditLogs).where(eq(businessAuditLogs.actorEmail, actorEmail));
  }
});

test("campaign reporting keeps delivered revenue after the remainder of an order is cancelled", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerMarketingRoutes }, { registerSalesRoutes }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
    import("./sales-routes"),
  ]);
  const requiredColumns = new Set([
    "marketing_attributions.source",
    "business_audit_logs.actor_email",
  ]);
  const availableColumns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (table_name, column_name) IN (
         ('marketing_attributions', 'source'),
         ('business_audit_logs', 'actor_email')
       )`,
  );
  for (const column of availableColumns.rows) requiredColumns.delete(`${column.table_name}.${column.column_name}`);
  if (requiredColumns.size > 0) {
    t.skip("requires the campaign attribution and business audit migrations");
    return;
  }

  const suffix = randomUUID();
  const prefix = `cancelled-campaign-order-${suffix}`;
  const actorEmail = `${prefix}@example.test`;
  const reportDate = "9999-12-31";
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerSalesRoutes(app, owner);
  registerMarketingRoutes(app, owner);
  app.use(((error: unknown, _req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  }) as ErrorRequestHandler);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, payload: await response.json() as any };
  };

  let campaignId: number | undefined;
  let destinationCampaignId: number | undefined;
  let customerId: number | undefined;
  const productIds: number[] = [];
  const orderIds: number[] = [];
  try {
    const before = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(before.response.status, 200, JSON.stringify(before.payload));

    const [campaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} campaign`,
      status: "active",
    }).returning();
    campaignId = campaign.id;
    const [destinationCampaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} destination`,
      status: "active",
    }).returning();
    destinationCampaignId = destinationCampaign.id;
    const [productA, productB] = await db.insert(products).values([
      {
        sku: `CANCEL-${suffix}-A`,
        name: `${prefix} product A`,
        sellingPriceZmw: "100.00",
        status: "active",
      },
      {
        sku: `CANCEL-${suffix}-B`,
        name: `${prefix} product B`,
        sellingPriceZmw: "60.00",
        status: "active",
      },
    ]).returning();
    productIds.push(productA.id, productB.id);
    const [customer] = await db.insert(customers).values({
      name: `${prefix} customer`,
    }).returning();
    customerId = customer.id;

    const [order] = await db.insert(salesOrders).values({
      orderNumber: `C-${suffix.slice(0, 30)}`,
      customerId: customer.id,
      status: "partially_fulfilled",
      orderDate: reportDate,
    }).returning();
    orderIds.push(order.id);
    const [lineA, lineB] = await db.insert(salesOrderLines).values([
      { salesOrderId: order.id, productId: productA.id, quantity: 5, unitPriceZmw: "100.00" },
      { salesOrderId: order.id, productId: productB.id, quantity: 4, unitPriceZmw: "60.00" },
    ]).returning();
    const [firstDelivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `CD1-${suffix.slice(0, 32)}`,
      salesOrderId: order.id,
      deliveryDate: reportDate,
    }).returning();
    const [secondDelivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `CD2-${suffix.slice(0, 32)}`,
      salesOrderId: order.id,
      deliveryDate: reportDate,
    }).returning();
    await db.insert(salesDeliveryLines).values([
      { deliveryId: firstDelivery.id, salesOrderLineId: lineA.id, quantity: 1 },
      { deliveryId: firstDelivery.id, salesOrderLineId: lineB.id, quantity: 2 },
      { deliveryId: secondDelivery.id, salesOrderLineId: lineA.id, quantity: 1 },
      { deliveryId: secondDelivery.id, salesOrderLineId: lineB.id, quantity: 1 },
    ]);
    await db.insert(marketingAttributions).values({
      salesOrderId: order.id,
      campaignId: campaign.id,
      source: "campaign_link",
    });

    const [undeliveredOrder] = await db.insert(salesOrders).values({
      orderNumber: `C0-${suffix.slice(0, 30)}`,
      customerId: customer.id,
      status: "partially_fulfilled",
      orderDate: reportDate,
    }).returning();
    orderIds.push(undeliveredOrder.id);
    await db.insert(salesOrderLines).values({
      salesOrderId: undeliveredOrder.id,
      productId: productA.id,
      quantity: 2,
      unitPriceZmw: "100.00",
    });
    await db.insert(marketingAttributions).values({
      salesOrderId: undeliveredOrder.id,
      campaignId: campaign.id,
      source: "campaign_link",
    });

    const cancelled = await request(`/api/sales-orders/${order.id}/cancel`, "POST", {});
    assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.payload));
    assert.equal(cancelled.payload.order.status, "cancelled");
    const undeliveredCancelled = await request(`/api/sales-orders/${undeliveredOrder.id}/cancel`, "POST", {});
    assert.equal(undeliveredCancelled.response.status, 200, JSON.stringify(undeliveredCancelled.payload));
    assert.equal(undeliveredCancelled.payload.order.status, "cancelled");

    const salesOrdersResponse = await request("/api/sales-orders");
    assert.equal(salesOrdersResponse.response.status, 200, JSON.stringify(salesOrdersResponse.payload));
    const salesOrder = salesOrdersResponse.payload.orders.find((item: { id: number }) => item.id === order.id);
    assert.ok(salesOrder);
    assert.equal(salesOrder.deliveredZmw, "380.00");
    assert.equal(salesOrder.totalZmw, "740.00");
    assert.equal(salesOrder.lines.length, 2);
    assert.deepEqual(
      salesOrder.lines.map((line: { productId: number; deliveredQuantity: number; remainingQuantity: number }) => [
        line.productId, line.deliveredQuantity, line.remainingQuantity,
      ]).sort((a: number[], b: number[]) => a[0] - b[0]),
      [[productA.id, 2, 3], [productB.id, 3, 1]].sort((a, b) => a[0] - b[0]),
    );
    assert.equal(salesOrder.deliveries.length, 2);

    const report = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(report.response.status, 200, JSON.stringify(report.payload));
    const campaignReport = report.payload.campaigns.find((item: { id: number }) => item.id === campaign.id);
    assert.ok(campaignReport);
    assert.equal(campaignReport.orderCount, 1);
    assert.equal(campaignReport.attributedRevenueZmw, salesOrder.deliveredZmw);
    assert.equal(report.payload.totals.campaignLinkOrders, before.payload.totals.campaignLinkOrders + 1);
    assert.equal(report.payload.totals.attributedOrders, before.payload.totals.attributedOrders + 1);

    const moved = await request(`/api/sales-orders/${order.id}/attribution`, "PATCH", {
      campaignId: destinationCampaign.id,
    });
    assert.equal(moved.response.status, 200, JSON.stringify(moved.payload));
    const afterMove = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    const oldCampaignAfterMove = afterMove.payload.campaigns.find(
      (item: { id: number }) => item.id === campaign.id,
    );
    const destinationAfterMove = afterMove.payload.campaigns.find(
      (item: { id: number }) => item.id === destinationCampaign.id,
    );
    assert.deepEqual({
      oldOrderCount: oldCampaignAfterMove.orderCount,
      oldRevenue: oldCampaignAfterMove.attributedRevenueZmw,
      newOrderCount: destinationAfterMove.orderCount,
      newRevenue: destinationAfterMove.attributedRevenueZmw,
      attributedOrdersDelta: afterMove.payload.totals.attributedOrders - before.payload.totals.attributedOrders,
      campaignLinkOrdersDelta: afterMove.payload.totals.campaignLinkOrders - before.payload.totals.campaignLinkOrders,
      ordersWithoutLinksDelta: afterMove.payload.totals.ordersWithoutCampaignLinks - before.payload.totals.ordersWithoutCampaignLinks,
    }, {
      oldOrderCount: 0,
      oldRevenue: "0.00",
      newOrderCount: 1,
      newRevenue: "380.00",
      attributedOrdersDelta: 1,
      campaignLinkOrdersDelta: 1,
      ordersWithoutLinksDelta: 0,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      if (orderIds.length) {
        await client.query("DELETE FROM marketing_attributions WHERE sales_order_id = ANY($1)", [orderIds]);
        await client.query(
          "DELETE FROM sales_delivery_lines WHERE delivery_id IN (SELECT id FROM sales_deliveries WHERE sales_order_id = ANY($1))",
          [orderIds],
        );
        await client.query("DELETE FROM sales_deliveries WHERE sales_order_id = ANY($1)", [orderIds]);
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = ANY($1)", [orderIds]);
        await client.query("DELETE FROM sales_orders WHERE id = ANY($1)", [orderIds]);
      }
      if (campaignId) await client.query("DELETE FROM marketing_campaigns WHERE id = $1", [campaignId]);
      if (destinationCampaignId) await client.query("DELETE FROM marketing_campaigns WHERE id = $1", [destinationCampaignId]);
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
      if (productIds.length) await client.query("DELETE FROM products WHERE id = ANY($1)", [productIds]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});

test("clearing a manual campaign assignment moves its totals to unattributed without changing link counts", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerMarketingRoutes }, { registerSalesRoutes }, { createBusinessAccessMiddleware }, { postJournal }] = await Promise.all([
    import("./db"),
    import("./marketing-routes"),
    import("./sales-routes"),
    import("./access-control"),
    import("./accounting-posting"),
  ]);
  const requiredColumns = new Set([
    "marketing_attributions.source",
    "business_audit_logs.actor_email",
  ]);
  const availableColumns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (table_name, column_name) IN (
         ('marketing_attributions', 'source'),
         ('business_audit_logs', 'actor_email')
       )`,
  );
  for (const column of availableColumns.rows) requiredColumns.delete(`${column.table_name}.${column.column_name}`);
  if (requiredColumns.size > 0) {
    t.skip("requires the campaign attribution and business audit migrations");
    return;
  }

  const suffix = randomUUID();
  const prefix = `cleared-campaign-assignment-${suffix}`;
  const actorEmail = `${prefix}@example.test`;
  const reportDate = "9999-12-31";
  const app = express();
  app.use(express.json());
  const access = createBusinessAccessMiddleware(
    async (userId) => ({
      authorized: true as const,
      actor: {
        clerkUserId: userId,
        email: userId === "test-manager" ? `${prefix}-manager@example.test` : actorEmail,
        role: userId === "test-manager" ? "manager" as const : "owner" as const,
      },
    }),
    (req) => req.header("x-test-user"),
  );
  registerSalesRoutes(app, access);
  registerMarketingRoutes(app, access);
  app.use(((error: unknown, _req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  }) as ErrorRequestHandler);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, method = "GET", body?: unknown, userId = "test-owner") => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "x-test-user": userId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, payload: await response.json() as any };
  };

  let campaignId: number | undefined;
  let customerId: number | undefined;
  let productId: number | undefined;
  const orderIds: number[] = [];
  try {
    const baseline = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(baseline.response.status, 200, JSON.stringify(baseline.payload));

    const [campaign] = await db.insert(marketingCampaigns).values({
      name: `${prefix} campaign`, status: "active",
    }).returning();
    campaignId = campaign.id;
    const [product] = await db.insert(products).values({
      sku: `CLR-${suffix}`,
      name: `${prefix} product`,
      sellingPriceZmw: "100.00",
      status: "active",
    }).returning();
    productId = product.id;
    const [customer] = await db.insert(customers).values({ name: `${prefix} customer` }).returning();
    customerId = customer.id;

    const [manualOrder] = await db.insert(salesOrders).values({
      orderNumber: `CLR-M-${suffix.slice(0, 24)}`,
      customerId: customer.id,
      status: "fulfilled",
      orderDate: reportDate,
    }).returning();
    const [linkOrder] = await db.insert(salesOrders).values({
      orderNumber: `CLR-L-${suffix.slice(0, 24)}`,
      customerId: customer.id,
      status: "fulfilled",
      orderDate: reportDate,
    }).returning();
    orderIds.push(manualOrder.id, linkOrder.id);
    const [manualLine, linkLine] = await db.insert(salesOrderLines).values([
      { salesOrderId: manualOrder.id, productId: product.id, quantity: 1, unitPriceZmw: "100.00" },
      { salesOrderId: linkOrder.id, productId: product.id, quantity: 1, unitPriceZmw: "50.00" },
    ]).returning();
    await db.insert(marketingAttributions).values([
      { salesOrderId: manualOrder.id, campaignId: campaign.id, source: "manual" },
      { salesOrderId: linkOrder.id, campaignId: campaign.id, source: "campaign_link" },
    ]);
    const [manualDelivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `CLR-DM-${suffix.slice(0, 24)}`,
      salesOrderId: manualOrder.id,
      deliveryDate: reportDate,
    }).returning();
    const [linkDelivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `CLR-DL-${suffix.slice(0, 24)}`,
      salesOrderId: linkOrder.id,
      deliveryDate: reportDate,
    }).returning();
    await db.insert(salesDeliveryLines).values([
      { deliveryId: manualDelivery.id, salesOrderLineId: manualLine.id, quantity: 1 },
      { deliveryId: linkDelivery.id, salesOrderLineId: linkLine.id, quantity: 1 },
    ]);
    await Promise.all([
      db.transaction((tx) => postJournal(tx, {
        sourceKey: `${prefix}-manual-cogs`,
        sourceType: "sales_delivery_cogs",
        sourceId: manualDelivery.id,
        memo: `${prefix} manual delivery cost`,
        entryDate: reportDate,
        lines: [
          { accountKey: "cost_of_goods_sold", productId: product.id, debitZmw: "30.00" },
          { accountKey: "inventory", productId: product.id, creditZmw: "30.00" },
        ],
      })),
      db.transaction((tx) => postJournal(tx, {
        sourceKey: `${prefix}-link-cogs`,
        sourceType: "sales_delivery_cogs",
        sourceId: linkDelivery.id,
        memo: `${prefix} link delivery cost`,
        entryDate: reportDate,
        lines: [
          { accountKey: "cost_of_goods_sold", productId: product.id, debitZmw: "20.00" },
          { accountKey: "inventory", productId: product.id, creditZmw: "20.00" },
        ],
      })),
      db.transaction((tx) => postJournal(tx, {
        sourceKey: `${prefix}-late-cost`,
        sourceType: "landed_cost_adjustment",
        sourceId: product.id,
        memo: `${prefix} shared late cost`,
        entryDate: reportDate,
        lines: [
          { accountKey: "cost_of_goods_sold", productId: product.id, debitZmw: "5.00" },
          { accountKey: "inventory", productId: product.id, creditZmw: "5.00" },
        ],
      })),
    ]);

    const beforeClear = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(beforeClear.response.status, 200, JSON.stringify(beforeClear.payload));
    const campaignBefore = beforeClear.payload.campaigns.find((item: { id: number }) => item.id === campaign.id);
    assert.ok(campaignBefore);
    assert.equal(campaignBefore.orderCount, 2);
    assert.equal(campaignBefore.attributedRevenueZmw, "150.00");
    assert.equal(campaignBefore.productCostZmw, "55.00");
    assert.equal(campaignBefore.landedCostAdjustmentZmw, "5.00");
    assert.deepEqual(campaignBefore.missingCostOrders, []);
    assert.equal(beforeClear.payload.totals.campaignLinkOrders, baseline.payload.totals.campaignLinkOrders + 1);
    assert.equal(beforeClear.payload.totals.ordersWithoutCampaignLinks, baseline.payload.totals.ordersWithoutCampaignLinks + 1);

    const managerClear = await request(
      `/api/sales-orders/${manualOrder.id}/attribution`,
      "PATCH",
      { campaignId: null },
      "test-manager",
    );
    assert.equal(managerClear.response.status, 403);
    const preservedAttribution = await db.select().from(marketingAttributions)
      .where(eq(marketingAttributions.salesOrderId, manualOrder.id));
    assert.equal(preservedAttribution[0]?.campaignId, campaign.id);
    assert.equal(preservedAttribution[0]?.source, "manual");

    const cleared = await request(`/api/sales-orders/${manualOrder.id}/attribution`, "PATCH", { campaignId: null });
    assert.equal(cleared.response.status, 200, JSON.stringify(cleared.payload));
    assert.equal(cleared.payload.campaignId, null);

    const afterClear = await request(`/api/marketing/reports?from=${reportDate}&to=${reportDate}`);
    assert.equal(afterClear.response.status, 200, JSON.stringify(afterClear.payload));
    const campaignAfter = afterClear.payload.campaigns.find((item: { id: number }) => item.id === campaign.id);
    assert.ok(campaignAfter);
    assert.equal(campaignAfter.orderCount, 1);
    assert.equal(campaignAfter.attributedRevenueZmw, "50.00");
    assert.equal(campaignAfter.productCostZmw, "22.00");
    assert.equal(campaignAfter.landedCostAdjustmentZmw, "2.00");
    assert.deepEqual(campaignAfter.missingCostOrders, []);
    assert.equal(
      BigInt(campaignAfter.productCostZmw.replace(".", "")) -
        BigInt(campaignBefore.productCostZmw.replace(".", "")),
      -3300n,
    );
    assert.equal(
      BigInt(campaignAfter.landedCostAdjustmentZmw.replace(".", "")) -
        BigInt(campaignBefore.landedCostAdjustmentZmw.replace(".", "")),
      -300n,
    );
    assert.equal(afterClear.payload.totals.attributedOrders, baseline.payload.totals.attributedOrders + 1);
    assert.equal(afterClear.payload.totals.unattributedOrders, baseline.payload.totals.unattributedOrders + 1);
    assert.equal(
      BigInt(afterClear.payload.totals.unattributedRevenueZmw.replace(".", "")) -
        BigInt(baseline.payload.totals.unattributedRevenueZmw.replace(".", "")),
      10000n,
    );
    assert.equal(afterClear.payload.totals.campaignLinkOrders, baseline.payload.totals.campaignLinkOrders + 1);
    assert.equal(afterClear.payload.totals.ordersWithoutCampaignLinks, baseline.payload.totals.ordersWithoutCampaignLinks + 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      await client.query(
        `DELETE FROM journal_lines WHERE journal_entry_id IN (
          SELECT id FROM journal_entries WHERE source_key LIKE $1
        )`,
        [`${prefix}-%`],
      );
      await client.query("DELETE FROM journal_entries WHERE source_key LIKE $1", [`${prefix}-%`]);
      if (orderIds.length) {
        await client.query("DELETE FROM marketing_attributions WHERE sales_order_id = ANY($1)", [orderIds]);
        await client.query(
          "DELETE FROM sales_delivery_lines WHERE delivery_id IN (SELECT id FROM sales_deliveries WHERE sales_order_id = ANY($1))",
          [orderIds],
        );
        await client.query("DELETE FROM sales_deliveries WHERE sales_order_id = ANY($1)", [orderIds]);
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = ANY($1)", [orderIds]);
        await client.query("DELETE FROM sales_orders WHERE id = ANY($1)", [orderIds]);
      }
      if (campaignId) await client.query("DELETE FROM marketing_campaigns WHERE id = $1", [campaignId]);
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
      if (productId) await client.query("DELETE FROM products WHERE id = $1", [productId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }
});
