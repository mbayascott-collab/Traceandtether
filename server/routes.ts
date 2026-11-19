import { clerkClient, getAuth } from "@clerk/express";
import type { RequestHandler } from "express";
import { and, asc, count, desc, eq, gte, ilike, lt, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { calculateProductProfitability } from "../shared/money";
import { auditLogCsv } from "../shared/audit-csv";
import {
  appUserAccess, appUsers, auditLogQuerySchema, businessAuditLogs, productCategories, products, supplierQuotes, suppliers,
} from "../shared/schema";
import { db } from "./db";
import { recordBusinessAudit } from "./audit";
import { databaseErrorStatus } from "./database-errors";
import { registerProcurementRoutes } from "./procurement-routes";
import { registerInventoryRoutes } from "./inventory-routes";
import { registerSalesRoutes } from "./sales-routes";
import { registerAccountingRoutes } from "./accounting-routes";
import { registerMarketingRoutes } from "./marketing-routes";
import { registerBusinessReportRoutes } from "./business-report-routes";
import { registerPaymentRoutes } from "./payment-routes";
import {
  categoryInputSchema, productInputSchema, supplierInputSchema, supplierQuoteInputSchema,
} from "./product-validation";
import {
  createBusinessAccessMiddleware, isPrimaryOwnerEmail, isProtectedAccessTarget, resolveBusinessAccount,
  normalizeVerifiedEmail, requireAccessManager, type AccountGrant, type BusinessRole, type UserResolution,
} from "./access-control";

type Actor = { clerkUserId: string; email: string; role: BusinessRole };

export async function resolveUser(userId: string): Promise<UserResolution> {
  const user = await clerkClient.users.getUser(userId);
  const primaryEmail = user.emailAddresses.find(
    (address) => address.id === user.primaryEmailAddressId,
  );

  const verified = normalizeVerifiedEmail(primaryEmail);
  if ("reason" in verified) {
    return { authorized: false as const, email: verified.email, reason: verified.reason };
  }

  const email = verified.email;
  const configuredOwner = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  if (!configuredOwner) {
    return { authorized: false, email, reason: "owner_not_configured" };
  }
  if (isPrimaryOwnerEmail(email, configuredOwner)) {
    await db.insert(appUserAccess).values({ email, role: "owner", active: true })
      .onConflictDoNothing();
  }

  const [grant] = await db
    .select({ role: appUserAccess.role, email: appUserAccess.email, active: appUserAccess.active })
    .from(appUserAccess)
    .where(eq(appUserAccess.email, email))
    .limit(1);

  const resolution = resolveBusinessAccount(userId, primaryEmail, grant as AccountGrant | undefined);
  if (!resolution.authorized) return resolution;
  await db.insert(appUsers).values({ clerkUserId: userId, email, role: resolution.actor.role })
    .onConflictDoUpdate({
      target: appUsers.clerkUserId,
      set: { email, role: resolution.actor.role, updatedAt: new Date() },
    });
  return resolution;
}

export const requireBusinessAccess: RequestHandler = createBusinessAccessMiddleware(
  resolveUser,
  (req) => getAuth(req).userId,
);

const productFiltersSchema = z.object({
  q: z.string().trim().max(160).optional(),
  status: z.enum(["all", "draft", "active", "inactive"]).default("all"),
  categoryId: z.string().regex(/^\d+$/).optional(),
  page: z.string().regex(/^\d+$/).default("1"),
  pageSize: z.string().regex(/^\d+$/).default("25"),
});

function serializeProduct(product: typeof products.$inferSelect) {
  return {
    ...product,
    ...calculateProductProfitability(
      product.sellingPriceZmw,
      product.estimatedLandedCostZmw,
    ),
  };
}

function validationMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the submitted values and try again.";
}

type AuditLogFilters = Pick<z.infer<typeof auditLogQuerySchema>, "entityType" | "actor" | "from" | "to">;

function auditLogWhere({ entityType, actor, from, to }: AuditLogFilters): SQL | undefined {
  const conditions: SQL[] = [];
  if (entityType) conditions.push(eq(businessAuditLogs.entityType, entityType));
  if (actor) {
    const escapedActor = actor.replace(/[\\%_]/g, "\\$&");
    conditions.push(ilike(businessAuditLogs.actorEmail, escapedActor));
  }
  if (from) conditions.push(gte(businessAuditLogs.createdAt, new Date(`${from}T00:00:00.000Z`)));
  if (to) {
    const through = new Date(`${to}T00:00:00.000Z`);
    through.setUTCDate(through.getUTCDate() + 1);
    conditions.push(lt(businessAuditLogs.createdAt, through));
  }
  return conditions.length ? and(...conditions) : undefined;
}

export function registerApiRoutes(
  app: import("express").Express,
  businessAccess: RequestHandler = requireBusinessAccess,
) {
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/me", async (req, res) => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Not signed in." });
      return;
    }

    try {
      const result = await resolveUser(userId);
      if (!result.authorized) {
        res.json({ authorized: false, email: result.email, role: null, reason: result.reason });
        return;
      }
      res.json({ authorized: true, email: result.actor.email, role: result.actor.role });
    } catch (error) {
      console.error(
        "Unable to load the current application user.",
        error instanceof Error ? error.name : "UnknownError",
      );
      res.status(503).json({ error: "Account access could not be checked. Try again shortly." });
    }
  });

  app.get("/api/user-access", businessAccess, async (_req, res) => {
    const users = await db.select().from(appUserAccess).orderBy(asc(appUserAccess.email));
    res.json({ users });
  });

  app.get("/api/audit-logs", businessAccess, async (req, res) => {
    const parsed = auditLogQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: validationMessage(parsed.error) });
      return;
    }
    const { page, pageSize } = parsed.data;
    const where = auditLogWhere(parsed.data);
    const offset = (page - 1) * pageSize;
    const [entries, [{ total }]] = await Promise.all([
      db.select().from(businessAuditLogs)
        .where(where)
        .orderBy(desc(businessAuditLogs.createdAt), desc(businessAuditLogs.id))
        .limit(pageSize)
        .offset(offset),
      db.select({ total: count() }).from(businessAuditLogs).where(where),
    ]);
    res.json({
      entries,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  });

  app.get("/api/audit-logs/export.csv", businessAccess, async (req, res) => {
    const parsed = auditLogQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: validationMessage(parsed.error) });
      return;
    }

    const entries = await db.select().from(businessAuditLogs)
      .where(auditLogWhere(parsed.data))
      .orderBy(desc(businessAuditLogs.createdAt), desc(businessAuditLogs.id));

    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="change-history.csv"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(auditLogCsv(entries));
  });

  app.post("/api/user-access", businessAccess, requireAccessManager(), async (req, res) => {
    const parsed = z.object({
      email: z.string().trim().email().max(320),
      displayName: z.string().trim().max(120).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter a valid email address and name." });
      return;
    }
    const email = parsed.data.email.toLowerCase();
    if (isPrimaryOwnerEmail(email, process.env.INITIAL_ADMIN_EMAIL)) {
      res.status(409).json({ error: "The primary owner account cannot be added as a manager." });
      return;
    }
    const [existing] = await db.select({ role: appUserAccess.role }).from(appUserAccess)
      .where(eq(appUserAccess.email, email)).limit(1);
    if (existing?.role === "owner") {
      res.status(409).json({ error: "The primary owner account cannot be changed here." });
      return;
    }
    await db.insert(appUserAccess).values({
      email, displayName: parsed.data.displayName || null, role: "manager", active: true,
      createdByClerkUserId: (res.locals.actor as Actor).clerkUserId,
    }).onConflictDoUpdate({
      target: appUserAccess.email,
      set: { displayName: parsed.data.displayName || null, role: "manager", active: true, updatedAt: new Date() },
    });
    res.status(201).json({ email, displayName: parsed.data.displayName || null, role: "manager", active: true });
  });

  app.patch("/api/user-access/:email", businessAccess, requireAccessManager(), async (req, res) => {
    const parsed = z.object({ active: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Choose whether this account should have access." });
      return;
    }
    const email = String(req.params.email).trim().toLowerCase();
    const actor = res.locals.actor as Actor;
    if (isProtectedAccessTarget(email, actor.email, process.env.INITIAL_ADMIN_EMAIL)) {
      res.status(409).json({ error: "You cannot change access for the primary owner or your own account." });
      return;
    }
    const [updated] = await db.update(appUserAccess).set({ active: parsed.data.active, updatedAt: new Date() })
      .where(and(eq(appUserAccess.email, email), eq(appUserAccess.role, "manager")))
      .returning({ email: appUserAccess.email, active: appUserAccess.active });
    if (!updated) {
      res.status(404).json({ error: "Manager account not found." });
      return;
    }
    res.json(updated);
  });

  app.get("/api/categories", businessAccess, async (_req, res) => {
    const categories = await db
      .select()
      .from(productCategories)
      .orderBy(asc(productCategories.name));
    res.json({ categories });
  });

  app.get("/api/suppliers", businessAccess, async (req, res) => {
    const parsed = z.object({
      q: z.string().trim().max(160).optional(),
      status: z.enum(["all", "active", "inactive"]).default("all"),
    }).safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: validationMessage(parsed.error) });
      return;
    }
    const conditions: SQL[] = [];
    if (parsed.data.q) {
      const escaped = parsed.data.q.replace(/[\\%_]/g, "\\$&");
      conditions.push(ilike(suppliers.name, `%${escaped}%`));
    }
    if (parsed.data.status !== "all") conditions.push(eq(suppliers.status, parsed.data.status));
    const rows = await db.select().from(suppliers)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(suppliers.name));
    res.json({ suppliers: rows });
  });

  app.post("/api/suppliers", businessAccess, async (req, res) => {
    const parsed = supplierInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationMessage(parsed.error) });
      return;
    }
    try {
      const [supplier] = await db.transaction(async (tx) => {
        const [created] = await tx.insert(suppliers).values(parsed.data).returning();
        await recordBusinessAudit(tx, {
          entityType: "supplier", entityId: created.id, recordLabel: created.name,
          actor: res.locals.actor as Actor, action: "created", changedFields: Object.keys(parsed.data),
        });
        return [created];
      });
      res.status(201).json({ supplier });
    } catch (error) {
      const databaseError = databaseErrorStatus(error, "A supplier with this name already exists.");
      if (databaseError) {
        res.status(databaseError.status).json({ error: databaseError.message });
        return;
      }
      throw error;
    }
  });

  app.patch("/api/suppliers/:id", businessAccess, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid supplier identifier." });
      return;
    }
    const parsed = supplierInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationMessage(parsed.error) });
      return;
    }
    try {
      const [supplier] = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
        if (!existing) return [undefined];
        const changedFields = Object.keys(parsed.data).filter(
          (key) =>
            existing[key as keyof typeof existing] !==
            parsed.data[key as keyof typeof parsed.data],
        );
        const [updated] = await tx.update(suppliers)
          .set({ ...parsed.data, updatedAt: new Date() })
          .where(eq(suppliers.id, id)).returning();
        if (updated && changedFields.length > 0) await recordBusinessAudit(tx, {
          entityType: "supplier", entityId: updated.id, recordLabel: updated.name,
          actor: res.locals.actor as Actor, action: "updated", changedFields,
        });
        return [updated];
      });
      if (!supplier) {
        res.status(404).json({ error: "Supplier not found." });
        return;
      }
      res.json({ supplier });
    } catch (error) {
      const databaseError = databaseErrorStatus(error, "A supplier with this name already exists.");
      if (databaseError) {
        res.status(databaseError.status).json({ error: databaseError.message });
        return;
      }
      throw error;
    }
  });

  app.get("/api/supplier-quotes", businessAccess, async (req, res) => {
    const parsed = z.object({ productId: z.string().regex(/^\d+$/).optional() }).safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid product filter." });
      return;
    }
    const rows = await db.select({
      quote: supplierQuotes,
      supplierName: suppliers.name,
      supplierStatus: suppliers.status,
      productName: products.name,
      productSku: products.sku,
    })
      .from(supplierQuotes)
      .innerJoin(suppliers, eq(supplierQuotes.supplierId, suppliers.id))
      .innerJoin(products, eq(supplierQuotes.productId, products.id))
      .where(parsed.data.productId ? eq(supplierQuotes.productId, Number(parsed.data.productId)) : undefined)
      .orderBy(asc(products.name), asc(supplierQuotes.currency), asc(supplierQuotes.unitPrice));
    res.json({ quotes: rows });
  });

  app.post("/api/supplier-quotes", businessAccess, async (req, res) => {
    const parsed = supplierQuoteInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationMessage(parsed.error) });
      return;
    }
    try {
      const [supplier] = await db.select({ status: suppliers.status }).from(suppliers)
        .where(eq(suppliers.id, parsed.data.supplierId)).limit(1);
      if (!supplier || supplier.status !== "active") {
        res.status(400).json({ error: "Choose an active supplier for this quote." });
        return;
      }
      const [quote] = await db.transaction(async (tx) => {
        const [created] = await tx.insert(supplierQuotes).values(parsed.data).returning();
        await recordBusinessAudit(tx, {
          entityType: "supplier_quote", entityId: created.id,
          recordLabel: `Supplier quote #${created.id}`, actor: res.locals.actor as Actor,
          action: "created", changedFields: Object.keys(parsed.data),
        });
        return [created];
      });
      res.status(201).json({ quote });
    } catch (error) {
      const databaseError = databaseErrorStatus(
        error,
        "That quote reference is already recorded for this supplier and product.",
      );
      if (databaseError) {
        res.status(databaseError.status).json({ error: databaseError.message });
        return;
      }
      throw error;
    }
  });

  app.patch("/api/supplier-quotes/:id", businessAccess, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid quotation identifier." });
      return;
    }
    const parsed = supplierQuoteInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationMessage(parsed.error) });
      return;
    }
    try {
      const [existing] = await db.select({ supplierId: supplierQuotes.supplierId }).from(supplierQuotes)
        .where(eq(supplierQuotes.id, id)).limit(1);
      if (!existing) {
        res.status(404).json({ error: "Quotation not found." });
        return;
      }
      if (existing.supplierId !== parsed.data.supplierId) {
        const [supplier] = await db.select({ status: suppliers.status }).from(suppliers)
          .where(eq(suppliers.id, parsed.data.supplierId)).limit(1);
        if (!supplier || supplier.status !== "active") {
          res.status(400).json({ error: "Choose an active supplier for this quote." });
          return;
        }
      }
      const [quote] = await db.transaction(async (tx) => {
        const [updated] = await tx.update(supplierQuotes)
          .set({ ...parsed.data, updatedAt: new Date() })
          .where(eq(supplierQuotes.id, id)).returning();
        if (updated) await recordBusinessAudit(tx, {
          entityType: "supplier_quote", entityId: updated.id,
          recordLabel: `Supplier quote #${updated.id}`, actor: res.locals.actor as Actor,
          action: "updated", changedFields: Object.keys(parsed.data),
        });
        return [updated];
      });
      res.json({ quote });
    } catch (error) {
      const databaseError = databaseErrorStatus(
        error,
        "That quote reference is already recorded for this supplier and product.",
      );
      if (databaseError) {
        res.status(databaseError.status).json({ error: databaseError.message });
        return;
      }
      throw error;
    }
  });

  app.post("/api/categories", businessAccess, async (req, res) => {
    const parsed = categoryInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationMessage(parsed.error) });
      return;
    }

    try {
      const [category] = await db.transaction(async (tx) => {
        const [created] = await tx.insert(productCategories).values(parsed.data).returning();
        await recordBusinessAudit(tx, {
          entityType: "category", entityId: created.id, recordLabel: created.name,
          actor: res.locals.actor as Actor, action: "created", changedFields: Object.keys(parsed.data),
        });
        return [created];
      });
      res.status(201).json({ category });
    } catch (error) {
      const databaseError = databaseErrorStatus(error);
      if (databaseError) {
        res.status(databaseError.status).json({ error: databaseError.message });
        return;
      }
      throw error;
    }
  });

  app.patch("/api/categories/:id", businessAccess, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid category identifier." });
      return;
    }
    const parsed = categoryInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationMessage(parsed.error) });
      return;
    }

    try {
      const [category] = await db.transaction(async (tx) => {
        const [updated] = await tx.update(productCategories)
          .set({ ...parsed.data, updatedAt: new Date() })
          .where(eq(productCategories.id, id)).returning();
        if (updated) await recordBusinessAudit(tx, {
          entityType: "category", entityId: updated.id, recordLabel: updated.name,
          actor: res.locals.actor as Actor, action: "updated", changedFields: Object.keys(parsed.data),
        });
        return [updated];
      });
      if (!category) {
        res.status(404).json({ error: "Category not found." });
        return;
      }
      res.json({ category });
    } catch (error) {
      const databaseError = databaseErrorStatus(error);
      if (databaseError) {
        res.status(databaseError.status).json({ error: databaseError.message });
        return;
      }
      throw error;
    }
  });

  app.get("/api/products", businessAccess, async (req, res) => {
    const parsedFilters = productFiltersSchema.safeParse(req.query);
    if (!parsedFilters.success) {
      res.status(400).json({ error: validationMessage(parsedFilters.error) });
      return;
    }

    const { q, status, categoryId, page, pageSize } = parsedFilters.data;
    const pageNumber = Math.max(1, Number(page));
    const limit = Math.min(100, Math.max(1, Number(pageSize)));
    const conditions: SQL[] = [];

    if (q) {
      const escaped = q.replace(/[\\%_]/g, "\\$&");
      const search = `%${escaped}%`;
      const searchCondition = or(
        ilike(products.name, search),
        ilike(products.sku, search),
        ilike(products.brand, search),
        ilike(products.supplierName, search),
        ilike(products.supplierProductCode, search),
      );
      if (searchCondition) conditions.push(searchCondition);
    }
    if (status !== "all") conditions.push(eq(products.status, status));
    if (categoryId) conditions.push(eq(products.categoryId, Number(categoryId)));
    const where = conditions.length ? and(...conditions) : undefined;

    const [items, [{ total }]] = await Promise.all([
      db
        .select()
        .from(products)
        .where(where)
        .orderBy(desc(products.updatedAt), asc(products.name))
        .limit(limit)
        .offset((pageNumber - 1) * limit),
      db.select({ total: count() }).from(products).where(where),
    ]);

    res.json({
      products: items.map(serializeProduct),
      pagination: {
        page: pageNumber,
        pageSize: limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  });

  app.post("/api/products", businessAccess, async (req, res) => {
    const parsed = productInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationMessage(parsed.error) });
      return;
    }
    const actor = res.locals.actor as Actor;

    try {
      const product = await db.transaction(async (tx) => {
        const [created] = await tx.insert(products).values(parsed.data).returning();
        await recordBusinessAudit(tx, {
          entityType: "product", entityId: created.id, recordLabel: created.name,
          actor, action: "created", changedFields: Object.keys(parsed.data),
        });
        return created;
      });
      res.status(201).json({ product: serializeProduct(product) });
    } catch (error) {
      const databaseError = databaseErrorStatus(error);
      if (databaseError) {
        res.status(databaseError.status).json({ error: databaseError.message });
        return;
      }
      throw error;
    }
  });

  app.put("/api/products/:id", businessAccess, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid product identifier." });
      return;
    }
    const parsed = productInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationMessage(parsed.error) });
      return;
    }
    const actor = res.locals.actor as Actor;

    try {
      const product = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(products).where(eq(products.id, id)).limit(1);
        if (!existing) return null;

        const changedFields = Object.keys(parsed.data).filter(
          (key) =>
            existing[key as keyof typeof existing] !==
            parsed.data[key as keyof typeof parsed.data],
        );
        const [updated] = await tx
          .update(products)
          .set({ ...parsed.data, updatedAt: new Date() })
          .where(eq(products.id, id))
          .returning();

        if (changedFields.length > 0) {
          await recordBusinessAudit(tx, {
            entityType: "product", entityId: id, recordLabel: updated.name,
            actor, action: "updated", changedFields,
          });
        }
        return updated;
      });

      if (!product) {
        res.status(404).json({ error: "Product not found." });
        return;
      }
      res.json({ product: serializeProduct(product) });
    } catch (error) {
      const databaseError = databaseErrorStatus(error);
      if (databaseError) {
        res.status(databaseError.status).json({ error: databaseError.message });
        return;
      }
      throw error;
    }
  });

  registerProcurementRoutes(app, businessAccess);
  registerInventoryRoutes(app, businessAccess);
  registerSalesRoutes(app, businessAccess);
  registerAccountingRoutes(app, businessAccess);
  registerMarketingRoutes(app, businessAccess);
  registerBusinessReportRoutes(app, businessAccess);
  registerPaymentRoutes(app, businessAccess);
}
