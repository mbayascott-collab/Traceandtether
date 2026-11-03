import { clerkClient, getAuth } from "@clerk/express";
import type { RequestHandler } from "express";
import { and, asc, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { calculateProductProfitability } from "../shared/money";
import {
  appUsers, productAuditLogs, productCategories, products, supplierQuotes, suppliers,
} from "../shared/schema";
import { db } from "./db";
import { databaseErrorStatus } from "./database-errors";
import { registerProcurementRoutes } from "./procurement-routes";
import { registerInventoryRoutes } from "./inventory-routes";
import { registerSalesRoutes } from "./sales-routes";
import {
  categoryInputSchema, productInputSchema, supplierInputSchema, supplierQuoteInputSchema,
} from "./product-validation";

type Actor = { clerkUserId: string; email: string };
type OwnerResolution =
  | { authorized: true; actor: Actor }
  | {
      authorized: false;
      email: string | null;
      reason: "owner_not_configured" | "email_not_approved" | "email_not_verified";
    };

async function resolveOwner(userId: string): Promise<OwnerResolution> {
  const user = await clerkClient.users.getUser(userId);
  const primaryEmail = user.emailAddresses.find(
    (address) => address.id === user.primaryEmailAddressId,
  );

  if (!primaryEmail || primaryEmail.verification?.status !== "verified") {
    return { authorized: false, email: primaryEmail?.emailAddress ?? null, reason: "email_not_verified" };
  }

  const email = primaryEmail.emailAddress.trim().toLowerCase();
  const configuredOwner = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  if (!configuredOwner) {
    return { authorized: false, email, reason: "owner_not_configured" };
  }
  if (email !== configuredOwner) {
    return { authorized: false, email, reason: "email_not_approved" };
  }

  await db
    .insert(appUsers)
    .values({ clerkUserId: userId, email, role: "owner" })
    .onConflictDoNothing();

  const [appUser] = await db
    .select({ role: appUsers.role, email: appUsers.email })
    .from(appUsers)
    .where(eq(appUsers.clerkUserId, userId))
    .limit(1);

  if (!appUser || appUser.role !== "owner" || appUser.email !== email) {
    return { authorized: false, email, reason: "email_not_approved" };
  }
  return { authorized: true, actor: { clerkUserId: userId, email } };
}

export const requireOwner: RequestHandler = async (req, res, next) => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Sign in to access the administration area." });
    return;
  }

  try {
    const result = await resolveOwner(userId);
    if (!result.authorized) {
      const status = result.reason === "owner_not_configured" ? 503 : 403;
      const message =
        result.reason === "owner_not_configured"
          ? "Owner access is not configured yet."
          : "This verified account is not approved for owner access.";
      res.status(status).json({ error: message });
      return;
    }
    res.locals.actor = result.actor;
    next();
  } catch (error) {
    console.error(
      "Unable to verify administrator access.",
      error instanceof Error ? error.name : "UnknownError",
    );
    res.status(503).json({ error: "Administrator access could not be verified. Try again shortly." });
  }
};

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

export function registerApiRoutes(app: import("express").Express) {
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
      const result = await resolveOwner(userId);
      if (!result.authorized) {
        res.json({ authorized: false, email: result.email, role: null, reason: result.reason });
        return;
      }
      res.json({ authorized: true, email: result.actor.email, role: "owner" });
    } catch (error) {
      console.error(
        "Unable to load the current application user.",
        error instanceof Error ? error.name : "UnknownError",
      );
      res.status(503).json({ error: "Account access could not be checked. Try again shortly." });
    }
  });

  app.get("/api/categories", requireOwner, async (_req, res) => {
    const categories = await db
      .select()
      .from(productCategories)
      .orderBy(asc(productCategories.name));
    res.json({ categories });
  });

  app.get("/api/suppliers", requireOwner, async (req, res) => {
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

  app.post("/api/suppliers", requireOwner, async (req, res) => {
    const parsed = supplierInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationMessage(parsed.error) });
      return;
    }
    try {
      const [supplier] = await db.insert(suppliers).values(parsed.data).returning();
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

  app.patch("/api/suppliers/:id", requireOwner, async (req, res) => {
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
      const [supplier] = await db.update(suppliers)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(suppliers.id, id)).returning();
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

  app.get("/api/supplier-quotes", requireOwner, async (req, res) => {
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

  app.post("/api/supplier-quotes", requireOwner, async (req, res) => {
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
      const [quote] = await db.insert(supplierQuotes).values(parsed.data).returning();
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

  app.patch("/api/supplier-quotes/:id", requireOwner, async (req, res) => {
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
      const [quote] = await db.update(supplierQuotes)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(supplierQuotes.id, id)).returning();
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

  app.post("/api/categories", requireOwner, async (req, res) => {
    const parsed = categoryInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationMessage(parsed.error) });
      return;
    }

    try {
      const [category] = await db
        .insert(productCategories)
        .values(parsed.data)
        .returning();
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

  app.patch("/api/categories/:id", requireOwner, async (req, res) => {
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
      const [category] = await db
        .update(productCategories)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(productCategories.id, id))
        .returning();
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

  app.get("/api/products", requireOwner, async (req, res) => {
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

  app.post("/api/products", requireOwner, async (req, res) => {
    const parsed = productInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: validationMessage(parsed.error) });
      return;
    }
    const actor = res.locals.actor as Actor;

    try {
      const product = await db.transaction(async (tx) => {
        const [created] = await tx.insert(products).values(parsed.data).returning();
        await tx.insert(productAuditLogs).values({
          productId: created.id,
          actorClerkUserId: actor.clerkUserId,
          action: "created",
          changedFields: Object.keys(parsed.data),
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

  app.put("/api/products/:id", requireOwner, async (req, res) => {
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
          (key) => {
            const previous = existing[key as keyof typeof existing];
            const next = parsed.data[key as keyof typeof parsed.data];
            return Array.isArray(previous) && Array.isArray(next)
              ? JSON.stringify(previous) !== JSON.stringify(next)
              : previous !== next;
          },
        );
        const [updated] = await tx
          .update(products)
          .set({ ...parsed.data, updatedAt: new Date() })
          .where(eq(products.id, id))
          .returning();

        if (changedFields.length > 0) {
          await tx.insert(productAuditLogs).values({
            productId: id,
            actorClerkUserId: actor.clerkUserId,
            action: parsed.data.status === "inactive" ? "deactivated" : "updated",
            changedFields,
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

  registerProcurementRoutes(app, requireOwner);
  registerInventoryRoutes(app, requireOwner);
  registerSalesRoutes(app, requireOwner);
}
