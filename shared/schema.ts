import {
  check,
  date,
  boolean,
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
export const inventoryMovementKind = pgEnum("inventory_movement_kind", ["stock_receipt", "adjustment", "reservation_fulfillment", "opening_stock", "stock_return", "stock_damage", "stock_transfer_in", "stock_transfer_out"]);
export const inventoryReservationStatus = pgEnum("inventory_reservation_status", ["active", "released", "fulfilled"]);
export const inventoryLocations = pgTable(
  "inventory_locations",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("inventory_locations_name_lower_unique").on(sql`lower(${table.name})`)],
);
export const customerStatus = pgEnum("customer_status", ["active", "inactive"]);
export const salesOrderStatus = pgEnum("sales_order_status", ["draft", "confirmed", "partially_fulfilled", "fulfilled", "cancelled"]);
export const customerQuoteStatus = pgEnum("customer_quote_status", ["draft", "sent", "accepted", "rejected", "converted"]);
export const accountingAccountType = pgEnum("accounting_account_type", ["asset", "liability", "equity", "income", "expense"]);
export const paymentDirection = pgEnum("payment_direction", ["customer_receipt", "supplier_payment"]);
export const paymentMethod = pgEnum("payment_method", ["cash", "bank_transfer", "mobile_money", "other"]);
export const marketingCampaignStatus = pgEnum("marketing_campaign_status", ["draft", "active", "paused", "completed", "cancelled"]);
export const marketingContentStatus = pgEnum("marketing_content_status", ["planned", "in_progress", "ready", "published", "cancelled"]);
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
    imageUrl: varchar("image_url", { length: 1000 }),
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

export const appUserAccess = pgTable("app_user_access", {
  email: varchar("email", { length: 320 }).primaryKey(),
  displayName: varchar("display_name", { length: 120 }),
  role: appRole("role").notNull().default("manager"),
  active: boolean("active").notNull().default(true),
  createdByClerkUserId: varchar("created_by_clerk_user_id", { length: 255 }),
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

export const shipmentPurchaseOrders = pgTable(
  "shipment_purchase_orders",
  {
    shipmentId: integer("shipment_id").notNull().references(() => shipments.id, { onDelete: "restrict" }),
    purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("shipment_purchase_orders_pair_unique").on(table.shipmentId, table.purchaseOrderId),
    index("shipment_purchase_orders_order_idx").on(table.purchaseOrderId),
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

export const customers = pgTable(
  "customers",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    contactPerson: varchar("contact_person", { length: 120 }),
    contactPersonPhone: varchar("contact_person_phone", { length: 60 }),
    email: varchar("email", { length: 254 }),
    phone: varchar("phone", { length: 60 }),
    address: text("address"),
    notes: text("notes"),
    status: customerStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("customers_name_idx").on(table.name),
    index("customers_status_idx").on(table.status),
  ],
);

export const salesOrders = pgTable(
  "sales_orders",
  {
    id: serial("id").primaryKey(),
    orderNumber: varchar("order_number", { length: 40 }).notNull(),
    customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
    status: salesOrderStatus("status").notNull().default("draft"),
    orderDate: date("order_date").notNull().defaultNow(),
    deliveryAddress: text("delivery_address"),
    notes: text("notes"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sales_orders_number_unique").on(table.orderNumber),
    index("sales_orders_customer_idx").on(table.customerId),
    index("sales_orders_status_idx").on(table.status),
  ],
);

export const salesOrderLines = pgTable(
  "sales_order_lines",
  {
    id: serial("id").primaryKey(),
    salesOrderId: integer("sales_order_id").notNull().references(() => salesOrders.id, { onDelete: "restrict" }),
    productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    unitPriceZmw: numeric("unit_price_zmw", { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sales_order_lines_product_unique").on(table.salesOrderId, table.productId),
    index("sales_order_lines_order_idx").on(table.salesOrderId),
    check("sales_order_lines_quantity_positive", sql`${table.quantity} > 0`),
    check("sales_order_lines_price_nonnegative", sql`${table.unitPriceZmw} >= 0`),
  ],
);

export const salesDeliveries = pgTable(
  "sales_deliveries",
  {
    id: serial("id").primaryKey(),
    deliveryNumber: varchar("delivery_number", { length: 40 }).notNull(),
    salesOrderId: integer("sales_order_id").notNull().references(() => salesOrders.id, { onDelete: "restrict" }),
    deliveryDate: date("delivery_date").notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sales_deliveries_number_unique").on(table.deliveryNumber),
    index("sales_deliveries_order_date_idx").on(table.salesOrderId, table.deliveryDate),
  ],
);

export const salesDeliveryLines = pgTable(
  "sales_delivery_lines",
  {
    id: serial("id").primaryKey(),
    deliveryId: integer("delivery_id").notNull().references(() => salesDeliveries.id, { onDelete: "restrict" }),
    salesOrderLineId: integer("sales_order_line_id").notNull().references(() => salesOrderLines.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sales_delivery_lines_delivery_order_line_unique").on(table.deliveryId, table.salesOrderLineId),
    index("sales_delivery_lines_order_line_idx").on(table.salesOrderLineId),
    check("sales_delivery_lines_quantity_positive", sql`${table.quantity} > 0`),
  ],
);

export const customerQuotes = pgTable(
  "customer_quotes",
  {
    id: serial("id").primaryKey(),
    quoteNumber: varchar("quote_number", { length: 40 }).notNull(),
    customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
    status: customerQuoteStatus("status").notNull().default("draft"),
    validUntil: date("valid_until"),
    deliveryAddress: text("delivery_address"),
    notes: text("notes"),
    emailSendStatus: varchar("email_send_status", { length: 16 }).notNull().default("not_sent"),
    emailAttemptedAt: timestamp("email_attempted_at", { withTimezone: true }),
    emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
    emailSendError: text("email_send_error"),
    salesOrderId: integer("sales_order_id").references(() => salesOrders.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("customer_quotes_number_unique").on(table.quoteNumber),
    uniqueIndex("customer_quotes_sales_order_unique").on(table.salesOrderId),
    index("customer_quotes_customer_idx").on(table.customerId),
    index("customer_quotes_status_idx").on(table.status),
    check("customer_quotes_email_send_status", sql`${table.emailSendStatus} in ('not_sent', 'sent', 'failed')`),
    check("customer_quotes_conversion_state", sql`(${table.status} = 'converted') = (${table.salesOrderId} is not null)`),
  ],
);

export const customerQuoteLines = pgTable(
  "customer_quote_lines",
  {
    id: serial("id").primaryKey(),
    customerQuoteId: integer("customer_quote_id").notNull().references(() => customerQuotes.id, { onDelete: "restrict" }),
    productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    unitPriceZmw: numeric("unit_price_zmw", { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("customer_quote_lines_product_unique").on(table.customerQuoteId, table.productId),
    index("customer_quote_lines_quote_idx").on(table.customerQuoteId),
    check("customer_quote_lines_quantity_positive", sql`${table.quantity} > 0`),
    check("customer_quote_lines_price_nonnegative", sql`${table.unitPriceZmw} >= 0`),
  ],
);

export const inventoryReservations = pgTable(
  "inventory_reservations",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    locationId: integer("location_id").references(() => inventoryLocations.id, { onDelete: "restrict" }),
    salesOrderId: integer("sales_order_id").references(() => salesOrders.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    status: inventoryReservationStatus("status").notNull().default("active"),
    reference: varchar("reference", { length: 120 }),
    reason: varchar("reason", { length: 500 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("inventory_reservations_product_status_idx").on(table.productId, table.status),
    uniqueIndex("inventory_reservations_sales_product_unique").on(table.salesOrderId, table.productId),
    check("inventory_reservations_quantity_positive", sql`${table.quantity} > 0`),
    check("inventory_reservations_reason_nonempty", sql`length(trim(${table.reason})) > 0`),
  ],
);

export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    locationId: integer("location_id").references(() => inventoryLocations.id, { onDelete: "restrict" }),
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

export const accountingAccounts = pgTable(
  "accounting_accounts",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 12 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    type: accountingAccountType("type").notNull(),
    systemKey: varchar("system_key", { length: 60 }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("accounting_accounts_code_unique").on(table.code),
    uniqueIndex("accounting_accounts_system_key_unique").on(table.systemKey),
  ],
);

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: serial("id").primaryKey(),
    entryNumber: varchar("entry_number", { length: 40 }).notNull(),
    sourceKey: varchar("source_key", { length: 180 }),
    sourceType: varchar("source_type", { length: 40 }).notNull(),
    sourceId: integer("source_id"),
    memo: varchar("memo", { length: 500 }).notNull(),
    entryDate: date("entry_date").notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("journal_entries_number_unique").on(table.entryNumber),
    uniqueIndex("journal_entries_source_key_unique").on(table.sourceKey),
    index("journal_entries_date_idx").on(table.entryDate),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: serial("id").primaryKey(),
    journalEntryId: integer("journal_entry_id").notNull().references(() => journalEntries.id, { onDelete: "restrict" }),
    accountId: integer("account_id").notNull().references(() => accountingAccounts.id, { onDelete: "restrict" }),
    productId: integer("product_id").references(() => products.id, { onDelete: "restrict" }),
    description: varchar("description", { length: 240 }),
    debitZmw: numeric("debit_zmw", { precision: 14, scale: 2 }).notNull().default("0"),
    creditZmw: numeric("credit_zmw", { precision: 14, scale: 2 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("journal_lines_entry_idx").on(table.journalEntryId),
    index("journal_lines_account_product_idx").on(table.accountId, table.productId),
    check("journal_lines_one_sided", sql`(${table.debitZmw} > 0 and ${table.creditZmw} = 0) or (${table.creditZmw} > 0 and ${table.debitZmw} = 0)`),
  ],
);

export const businessPayments = pgTable(
  "business_payments",
  {
    id: serial("id").primaryKey(),
    paymentNumber: varchar("payment_number", { length: 40 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 80 }).notNull().default(sql`gen_random_uuid()::text`),
    direction: paymentDirection("direction").notNull(),
    salesOrderId: integer("sales_order_id").references(() => salesOrders.id, { onDelete: "restrict" }),
    purchaseOrderId: integer("purchase_order_id").references(() => purchaseOrders.id, { onDelete: "restrict" }),
    amountZmw: numeric("amount_zmw", { precision: 14, scale: 2 }).notNull(),
    paymentDate: date("payment_date").notNull(),
    method: paymentMethod("method").notNull(),
    reference: varchar("reference", { length: 120 }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("business_payments_number_unique").on(table.paymentNumber),
    uniqueIndex("business_payments_idempotency_key_unique").on(table.idempotencyKey),
    index("business_payments_sales_order_idx").on(table.salesOrderId),
    index("business_payments_purchase_order_idx").on(table.purchaseOrderId),
    index("business_payments_date_idx").on(table.paymentDate),
    check("business_payments_positive_amount", sql`${table.amountZmw} > 0`),
    check(
      "business_payments_order_matches_direction",
      sql`(${table.direction} = 'customer_receipt' and ${table.salesOrderId} is not null and ${table.purchaseOrderId} is null) or (${table.direction} = 'supplier_payment' and ${table.purchaseOrderId} is not null and ${table.salesOrderId} is null)`,
    ),
  ],
);

export const businessExpenses = pgTable(
  "business_expenses",
  {
    id: serial("id").primaryKey(),
    category: varchar("category", { length: 40 }).notNull(),
    description: varchar("description", { length: 240 }).notNull(),
    amountZmw: numeric("amount_zmw", { precision: 14, scale: 2 }).notNull(),
    expenseDate: date("expense_date").notNull(),
    method: paymentMethod("method").notNull(),
    reference: varchar("reference", { length: 120 }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("business_expenses_date_idx").on(table.expenseDate),
    check("business_expenses_positive_amount", sql`${table.amountZmw} > 0`),
  ],
);

export const marketingCampaigns = pgTable(
  "marketing_campaigns",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 180 }).notNull(),
    objective: text("objective"),
    channel: varchar("channel", { length: 80 }),
    status: marketingCampaignStatus("status").notNull().default("draft"),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    budgetZmw: numeric("budget_zmw", { precision: 14, scale: 2 }),
    notes: text("notes"),
    trackingCode: varchar("tracking_code", { length: 36 }).notNull().default(sql`gen_random_uuid()::text`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("marketing_campaigns_tracking_code_unique").on(table.trackingCode),
    index("marketing_campaigns_status_idx").on(table.status),
    check("marketing_campaigns_budget_nonnegative", sql`${table.budgetZmw} is null or ${table.budgetZmw} >= 0`),
    check("marketing_campaigns_date_order", sql`${table.startsOn} is null or ${table.endsOn} is null or ${table.endsOn} >= ${table.startsOn}`),
  ],
);

export const marketingCustomerGroups = pgTable(
  "marketing_customer_groups",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    rules: jsonb("rules").$type<{
      minimumFulfilledOrders?: number;
      maximumFulfilledOrders?: number;
      noOrderInLastDays?: number;
      minimumLifetimeSalesZmw?: string;
    }>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("marketing_customer_groups_name_idx").on(table.name)],
);

export const marketingContentItems = pgTable(
  "marketing_content_items",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id").references(() => marketingCampaigns.id, { onDelete: "set null" }),
    title: varchar("title", { length: 180 }).notNull(),
    platform: varchar("platform", { length: 80 }).notNull(),
    contentType: varchar("content_type", { length: 80 }).notNull(),
    status: marketingContentStatus("status").notNull().default("planned"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    caption: text("caption"),
    publishedUrl: varchar("published_url", { length: 2_000 }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("marketing_content_campaign_idx").on(table.campaignId),
    index("marketing_content_schedule_idx").on(table.scheduledAt),
  ],
);

export const marketingExpenses = pgTable(
  "marketing_expenses",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id").references(() => marketingCampaigns.id, { onDelete: "set null" }),
    category: varchar("category", { length: 80 }).notNull(),
    description: varchar("description", { length: 240 }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    exchangeRateToZmw: numeric("exchange_rate_to_zmw", { precision: 18, scale: 8 }).notNull(),
    expenseDate: date("expense_date").notNull().defaultNow(),
    paid: boolean("paid").notNull().default(false),
    reference: varchar("reference", { length: 120 }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("marketing_expenses_campaign_idx").on(table.campaignId),
    check("marketing_expenses_amount_positive", sql`${table.amount} > 0`),
    check("marketing_expenses_fx_positive", sql`${table.exchangeRateToZmw} > 0`),
  ],
);

export const marketingAttributions = pgTable(
  "marketing_attributions",
  {
    id: serial("id").primaryKey(),
    salesOrderId: integer("sales_order_id").notNull().references(() => salesOrders.id, { onDelete: "cascade" }),
    campaignId: integer("campaign_id").notNull().references(() => marketingCampaigns.id, { onDelete: "restrict" }),
    source: varchar("source", { length: 20 }).notNull().default("manual"),
    attributedAt: timestamp("attributed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("marketing_attributions_order_unique").on(table.salesOrderId),
    index("marketing_attributions_campaign_idx").on(table.campaignId),
    check("marketing_attributions_source_valid", sql`${table.source} in ('manual', 'campaign_link')`),
  ],
);
