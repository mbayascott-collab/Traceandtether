# Project roadmap

## Current state

### Phase 1 — Foundation and product management

**Implemented in this milestone**

- React/TypeScript frontend with Express API and a shared PostgreSQL database.
- Clerk sign-in and owner-only API authorization.
- Product categories with create, edit, and active/inactive status.
- Products with SKU, category, supplier reference, currency, purchase price, estimated landed cost, ZMW selling price, unit, reorder threshold, and draft/active/inactive status.
- Server-side validation, case-insensitive unique SKU/category names, product search, filters, and pagination.
- Exact-decimal estimated gross profit and gross margin calculations.
- Transactional product audit entries for create and edit actions.
- Responsive administration workspace and data-backed dashboard summary.

**Limitations**

- Owner access requires `INITIAL_ADMIN_EMAIL` to be configured.
- Only the verified initial owner is authorised; employee role assignment is not included.
- Product image uploads and permanent file storage are not included.
- Product-level inventory balances, traceable movements, reservations, receipts, adjustments, purchase orders, shipments, import costs, customer records, and sales order processing are implemented. Payments, multi-location stock, taxes, and accounting remain out of scope.
- The interface displays only stored product/category data; no demo business records are seeded.

## Planned phases

1. **Phase 1 — Foundation and product management:** implementation is in place; the owner email is configured. Signed-in CRUD still needs manual verification after the owner creates and verifies the Clerk account.
2. **Phase 2 — Suppliers, purchasing, and imports:** supplier profiles, product quotations, supplier comparisons, purchase orders, shipment records and receipts, import expenses, and landed-cost allocations are implemented.
3. **Phase 3 — Inventory:** product-level ledger, stock receipts from received shipments, reservations, and reasoned adjustments are implemented. Stock locations, valuation, and reorder alerts remain.
4. **Phase 4 — Sales and online shop:** owner-managed customer and sales orders are implemented. A public, stock-aware catalogue and manual order-request checkout are implemented; Shopify integration is deferred until funding is available. Online payments, shipping-rate calculation, and automated delivery remain deferred.
5. **Phase 5 — Accounting foundation:** a ZMW chart of accounts, balanced source-linked journals, and automated posting for import expenses, stock receipts, inventory adjustments, and fulfilled sales are implemented. Opening balances, payments, tax, bank reconciliation, and accountant-reviewed reports remain.
6. **Phase 6 — Marketing and CRM:** campaign management, content planning, and source-currency marketing expense recording with ZMW accounting posting are implemented. Customer groups, attribution, promotions, and marketing reporting remain.
7. **Phase 7 — Business intelligence:** consolidated dashboards, profitability, replenishment recommendations, cash-flow forecasts, and reports.
8. **Phase 8 — Production readiness:** broader security review, recovery procedures, performance, coverage, documentation, and deployment validation.

Features move to complete only after their stored-data behavior, validation, authorization, and relevant tests have been verified.
