import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const productStatus = pgEnum("product_status", ["draft", "active", "inactive"]);
export const categoryStatus = pgEnum("category_status", ["active", "inactive"]);
export const supplierStatus = pgEnum("supplier_status", ["active", "inactive"]);
export const supplierQuoteStatus = pgEnum("supplier_quote_status", ["received", "accepted", "rejected"]);
export const appRole = pgEnum("app_role", [
  "owner",
  "manager",
  "sales",
  "inventory",
  "marketing",
  "accountant",
  "reviewer",
]);

export const productCategories = pgTable(
  "product_categories",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 80 }).notNull(),
    description: varchar("description", { length: 500 }),
    status: categoryStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("product_categories_name_lower_unique").on(sql`lower(${table.name})`),
  ],
);

export const products = pgTable(
  "products",
  {
    id: serial("id").primaryKey(),
    sku: varchar("sku", { length: 60 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    brand: varchar("brand", { length: 100 }),
    categoryId: integer("category_id").references(() => productCategories.id, {
      onDelete: "set null",
    }),
    supplierName: varchar("supplier_name", { length: 160 }),
    supplierProductCode: varchar("supplier_product_code", { length: 100 }),
    purchaseCurrency: varchar("purchase_currency", { length: 3 }).notNull().default("CNY"),
    purchasePrice: numeric("purchase_price", { precision: 14, scale: 2 }),
    estimatedLandedCostZmw: numeric("estimated_landed_cost_zmw", {
      precision: 14,
      scale: 2,
    }),
    sellingPriceZmw: numeric("selling_price_zmw", { precision: 14, scale: 2 }),
    reorderThreshold: integer("reorder_threshold").notNull().default(0),
    unit: varchar("unit", { length: 32 }).notNull().default("unit"),
    status: productStatus("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("products_sku_lower_unique").on(sql`lower(${table.sku})`),
    index("products_status_idx").on(table.status),
    index("products_category_idx").on(table.categoryId),
    index("products_updated_at_idx").on(table.updatedAt),
    check(
      "products_purchase_price_nonnegative",
      sql`${table.purchasePrice} is null or ${table.purchasePrice} >= 0`,
    ),
    check(
      "products_landed_cost_nonnegative",
      sql`${table.estimatedLandedCostZmw} is null or ${table.estimatedLandedCostZmw} >= 0`,
    ),
    check(
      "products_selling_price_nonnegative",
      sql`${table.sellingPriceZmw} is null or ${table.sellingPriceZmw} >= 0`,
    ),
    check("products_reorder_threshold_nonnegative", sql`${table.reorderThreshold} >= 0`),
  ],
);

export const appUsers = pgTable("app_users", {
  clerkUserId: varchar("clerk_user_id", { length: 255 }).primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  role: appRole("role").notNull().default("reviewer"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const productAuditLogs = pgTable("product_audit_logs", {
  id: serial("id").primaryKey(),
  productId: integer("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "restrict" }),
  actorClerkUserId: varchar("actor_clerk_user_id", { length: 255 }).notNull(),
  action: varchar("action", { length: 16 }).notNull(),
  changedFields: jsonb("changed_fields").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const suppliers = pgTable(
  "suppliers",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    country: varchar("country", { length: 80 }),
    contactName: varchar("contact_name", { length: 120 }),
    email: varchar("email", { length: 254 }),
    phone: varchar("phone", { length: 60 }),
    website: varchar("website", { length: 300 }),
    paymentTerms: varchar("payment_terms", { length: 300 }),
    defaultLeadTimeDays: integer("default_lead_time_days").notNull().default(0),
    notes: text("notes"),
    status: supplierStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("suppliers_name_lower_unique").on(sql`lower(${table.name})`),
    check("suppliers_lead_time_nonnegative", sql`${table.defaultLeadTimeDays} >= 0`),
  ],
);

export const supplierQuotes = pgTable(
  "supplier_quotes",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quoteReference: varchar("quote_reference", { length: 100 }),
    supplierProductCode: varchar("supplier_product_code", { length: 100 }),
    unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    minimumOrderQuantity: integer("minimum_order_quantity").notNull().default(1),
    leadTimeDays: integer("lead_time_days").notNull().default(0),
    validUntil: date("valid_until"),
    paymentTerms: varchar("payment_terms", { length: 300 }),
    shippingTerms: varchar("shipping_terms", { length: 120 }),
    notes: text("notes"),
    status: supplierQuoteStatus("status").notNull().default("received"),
    quotedAt: timestamp("quoted_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("supplier_quotes_product_idx").on(table.productId),
    index("supplier_quotes_supplier_idx").on(table.supplierId),
    index("supplier_quotes_status_idx").on(table.status),
    uniqueIndex("supplier_quotes_reference_unique").on(table.supplierId, table.productId, table.quoteReference),
    check("supplier_quotes_price_nonnegative", sql`${table.unitPrice} >= 0`),
    check("supplier_quotes_moq_positive", sql`${table.minimumOrderQuantity} > 0`),
    check("supplier_quotes_lead_time_nonnegative", sql`${table.leadTimeDays} >= 0`),
  ],
);
