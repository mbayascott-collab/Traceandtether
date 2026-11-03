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
export const purchaseOrderStatus = pgEnum("purchase_order_status", ["ordered", "partially_received", "received", "cancelled"]);
export const shipmentStatus = pgEnum("shipment_status", ["in_transit", "partially_received", "received", "cancelled"]);
export const allocationBasis = pgEnum("allocation_basis", ["value", "quantity"]);
export const inventoryMovementKind = pgEnum("inventory_movement_kind", ["stock_receipt", "adjustment", "reservation_fulfillment"]);
export const inventoryReservationStatus = pgEnum("inventory_reservation_status", ["active", "released", "fulfilled"]);
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

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: serial("id").primaryKey(),
    orderNumber: varchar("order_number", { length: 40 }).notNull(),
    supplierId: integer("supplier_id").notNull().references(() => suppliers.id, { onDelete: "restrict" }),
    status: purchaseOrderStatus("status").notNull().default("ordered"),
    currency: varchar("currency", { length: 3 }).notNull(),
    exchangeRateToZmw: numeric("exchange_rate_to_zmw", { precision: 18, scale: 8 }).notNull(),
    orderedAt: date("ordered_at").notNull().defaultNow(),
    expectedAt: date("expected_at"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("purchase_orders_number_unique").on(table.orderNumber),
    index("purchase_orders_supplier_idx").on(table.supplierId),
    index("purchase_orders_status_idx").on(table.status),
    check("purchase_orders_fx_positive", sql`${table.exchangeRateToZmw} > 0`),
  ],
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: serial("id").primaryKey(),
    purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "restrict" }),
    productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    quantityOrdered: integer("quantity_ordered").notNull(),
    unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("purchase_order_lines_product_unique").on(table.purchaseOrderId, table.productId),
    index("purchase_order_lines_order_idx").on(table.purchaseOrderId),
    check("purchase_order_lines_quantity_positive", sql`${table.quantityOrdered} > 0`),
    check("purchase_order_lines_price_nonnegative", sql`${table.unitPrice} >= 0`),
  ],
);

export const shipments = pgTable(
  "shipments",
  {
    id: serial("id").primaryKey(),
    purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "restrict" }),
    shipmentReference: varchar("shipment_reference", { length: 100 }),
    carrier: varchar("carrier", { length: 120 }),
    trackingNumber: varchar("tracking_number", { length: 120 }),
    status: shipmentStatus("status").notNull().default("in_transit"),
    shippedAt: date("shipped_at"),
    expectedAt: date("expected_at"),
    receivedAt: date("received_at"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("shipments_order_idx").on(table.purchaseOrderId),
    uniqueIndex("shipments_reference_per_order_unique").on(table.purchaseOrderId, table.shipmentReference),
  ],
);

export const shipmentLines = pgTable(
  "shipment_lines",
  {
    id: serial("id").primaryKey(),
    shipmentId: integer("shipment_id").notNull().references(() => shipments.id, { onDelete: "restrict" }),
    purchaseOrderLineId: integer("purchase_order_line_id").notNull().references(() => purchaseOrderLines.id, { onDelete: "restrict" }),
    quantityShipped: integer("quantity_shipped").notNull(),
    quantityReceived: integer("quantity_received").notNull().default(0),
    quantityStocked: integer("quantity_stocked").notNull().default(0),
  },
  (table) => [
    index("shipment_lines_shipment_idx").on(table.shipmentId),
    index("shipment_lines_order_line_idx").on(table.purchaseOrderLineId),
    check("shipment_lines_shipped_positive", sql`${table.quantityShipped} > 0`),
    check("shipment_lines_received_range", sql`${table.quantityReceived} >= 0 and ${table.quantityReceived} <= ${table.quantityShipped}`),
    check("shipment_lines_stocked_range", sql`${table.quantityStocked} >= 0 and ${table.quantityStocked} <= ${table.quantityReceived}`),
  ],
);

export const inventoryReservations = pgTable(
  "inventory_reservations",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    status: inventoryReservationStatus("status").notNull().default("active"),
    reference: varchar("reference", { length: 120 }),
    reason: varchar("reason", { length: 500 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("inventory_reservations_product_status_idx").on(table.productId, table.status),
    check("inventory_reservations_quantity_positive", sql`${table.quantity} > 0`),
    check("inventory_reservations_reason_nonempty", sql`length(trim(${table.reason})) > 0`),
  ],
);

export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    kind: inventoryMovementKind("kind").notNull(),
    quantityDelta: integer("quantity_delta").notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    reference: varchar("reference", { length: 120 }),
    sourceKey: varchar("source_key", { length: 160 }),
    reservationId: integer("reservation_id").references(() => inventoryReservations.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("inventory_movements_product_created_idx").on(table.productId, table.createdAt),
    uniqueIndex("inventory_movements_source_key_unique").on(table.sourceKey),
    check("inventory_movements_delta_nonzero", sql`${table.quantityDelta} <> 0`),
    check("inventory_movements_reason_nonempty", sql`length(trim(${table.reason})) > 0`),
  ],
);

export const importExpenses = pgTable(
  "import_expenses",
  {
    id: serial("id").primaryKey(),
    purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "restrict" }),
    category: varchar("category", { length: 80 }).notNull(),
    description: varchar("description", { length: 240 }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    exchangeRateToZmw: numeric("exchange_rate_to_zmw", { precision: 18, scale: 8 }).notNull(),
    basis: allocationBasis("basis").notNull().default("value"),
    incurredAt: date("incurred_at").notNull().defaultNow(),
    reference: varchar("reference", { length: 120 }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("import_expenses_order_idx").on(table.purchaseOrderId),
    check("import_expenses_amount_positive", sql`${table.amount} > 0`),
    check("import_expenses_fx_positive", sql`${table.exchangeRateToZmw} > 0`),
  ],
);
