# Database design

## Database and migration approach

The application uses the workspace's Replit-managed PostgreSQL database and Drizzle ORM. `shared/schema.ts` is the schema source of truth. SQL migrations are generated into `drizzle/` and are checked into source control.

Development uses `npm run db:generate` followed by `npm run db:migrate`. Replit's Publish flow applies managed database schema changes to production. The application does not perform schema creation or migration at startup.

The development database was empty before the first migration. The migration creates new tables and constraints only; it does not seed products, categories, or customer data.

## Tables

### `product_categories`

- `id` — generated primary key.
- `name` — required, case-insensitively unique category name.
- `description` — optional.
- `status` — `active` or `inactive`.
- `created_at`, `updated_at` — timezone-aware timestamps.

Products reference a category with `products.category_id`. Deactivating a category preserves it; removing a category relationship does not delete historical products.

### `products`

- `id` — generated primary key.
- `sku` — required, case-insensitively unique internal identifier.
- `name`, `description`, `brand`.
- `category_id` — optional foreign key to `product_categories`.
- `supplier_name`, `supplier_product_code` — optional supplier reference fields.

## Suppliers and quotations

- `suppliers` stores internal contact and commercial details with an active/inactive status. Inactivation preserves records and history.
- `supplier_quotes` links a supplier to a product and stores quoted unit price, currency, MOQ, lead time, validity, terms, reference, and received/accepted/rejected status.
- Supplier deletion is restricted when quotations reference the supplier; inactivation preserves quote history.
- Quote prices remain in their source currency. The comparison view does not rank values across currencies or claim a landed-cost total.
- Supplier and quote records are exposed only through owner-protected API routes.
- `purchase_currency` — three-letter currency code, default `CNY`.
- `purchase_price` — optional `NUMERIC(14,2)` in the purchase currency.
- `estimated_landed_cost_zmw` — optional `NUMERIC(14,2)`.
- `selling_price_zmw` — optional `NUMERIC(14,2)`.
- `reorder_threshold` — non-negative integer.
- `unit` — unit label.
- `status` — `draft`, `active`, or `inactive`.
- `created_at`, `updated_at` — timezone-aware timestamps.

Price columns use PostgreSQL fixed-precision numeric values, not floating-point columns. The API rejects negative prices. Active products require a positive selling price. A disabled or deleted product record is not used to erase history; this milestone offers status changes rather than deletion.

### `app_users`

Stores the Clerk user ID, verified email, and application role. The first owner row is created on the first authenticated request when the user's verified primary email matches the `INITIAL_ADMIN_EMAIL` environment setting. The role value is checked by the server; frontend visibility alone is not authorization.

### `product_audit_logs`

Records product creation and edits, the authenticated Clerk user ID, action, changed field names, and timestamp. Product writes and corresponding audit rows are committed in one database transaction.

## Relationships and constraints

- Product category is optional and uses `ON DELETE SET NULL`.
- Product audit references use `ON DELETE RESTRICT`.
- Product SKUs and category names are unique case-insensitively.
- Database checks reject negative purchase prices, estimated landed costs, selling prices, and reorder thresholds.
- Indexes support filtering by product status/category and ordering by update time.
