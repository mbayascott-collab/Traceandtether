# Development log

## 2026-10-29 — Phase 1 foundation

- Inspected the workspace: no application source, database schema, or authentication implementation existed; Node.js 24 and the managed PostgreSQL environment were available.
- Confirmed the development database had no public tables before the new schema.
- Added React/Vite + Express/TypeScript foundation, managed Clerk auth wiring, Drizzle schema/migration source, owner-email access configuration, product/category APIs, and initial product-management UI.
- Added documentation for the project roadmap, database model, product business rules, security boundaries, and test instructions.
- No product or category demo records are seeded.
- Applied the initial development database migrations; confirmed the product and category tables are empty.
- Configured the exact verified owner email through the shared `INITIAL_ADMIN_EMAIL` environment setting; no password or credential was collected.
- `npm test`: 9 tests passed.
- `npm run build`: Vite production build and TypeScript check passed.
- Runtime checks: `/api/health` returned 200; unauthenticated `/api/me` and `/api/products` returned 401.
- Visually checked the public landing page at desktop width and the Clerk sign-in screen at mobile width. Signed-in CRUD remains for the owner to verify.

## 2026-11-03 — Supplier records and quotations

- Added private supplier profiles, product-linked quotations, and a comparison view that keeps quoted currencies separate and does not invent exchange rates or landed costs.
- Added owner-protected supplier and quotation APIs, validation, uniqueness/range constraints, and an additive Drizzle migration.
- Applied the migration to development PostgreSQL; existing product, category, user, and audit-log counts were preserved.
- Temporary supplier/quotation database check passed for create, read from a separate connection, edit, comparison join, duplicate supplier rejection, and cleanup.
- `npm test`: 12 tests passed. `npm run build`: passed.
- Health returned 200; anonymous supplier, quotation, and product API requests returned 401. Signed-in UI interaction still requires an owner session.
- Confirmed Drizzle-wrapped PostgreSQL constraint errors are mapped to user-safe conflict/range responses.
