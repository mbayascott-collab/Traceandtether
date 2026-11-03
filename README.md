# Trade Desk

Trade Desk is a private business operations workspace for a Zambia-focused importing and resale business. It now includes product/category management, internal supplier records, product quotations, and source-currency comparisons. It does not contain the public shop, inventory, purchase orders, shipment tracking, payments, accounting, or marketing modules.

## Technology

- React, TypeScript, and Vite for the browser interface.
- Express for the server-side API.
- Replit-managed PostgreSQL with Drizzle ORM and checked-in SQL migrations.
- Replit-managed Clerk for verified sign-in.

## Run the application

The workspace provides `DATABASE_URL` and PostgreSQL connection settings. Clerk is configured through Replit Auth setup and its keys are stored as managed secrets.

1. Set the non-secret `INITIAL_ADMIN_EMAIL` environment variable to the owner's sign-in email. The account must use that exact verified email address.
2. Apply development schema changes with `npm run db:migrate`.
3. Start the preview with `npm run dev` (port 5000).

The app fails clearly when the database connection is missing. If `INITIAL_ADMIN_EMAIL` is not set, sign-in can load but no account is granted administration access.

## Database changes

1. Edit the Drizzle schema in `shared/schema.ts`.
2. Generate a reviewed migration with `npm run db:generate`.
3. Apply that migration to the development database with `npm run db:migrate`.
4. Verify the feature in development.
5. Re-publish to apply schema changes to Replit's managed production database. Do not run development migrations against production or add startup-time schema creation.

The current development database was empty when this schema was added. No product or category sample data is seeded.

## Tests and build

- `npm test` runs unit tests for exact-decimal money calculations and product, supplier, and quotation validation.
- `npm run build` builds the frontend and type-checks the project.

See [docs/TESTING.md](docs/TESTING.md) for manual checks and known limitations.

## Environment configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Replit-managed PostgreSQL connection; provided by the workspace |
| `INITIAL_ADMIN_EMAIL` | Exact verified email address allowed to receive the initial owner role |
| `CLERK_SECRET_KEY` | Managed Clerk server key; supplied by Replit and never placed in client code |
| `CLERK_PUBLISHABLE_KEY` | Managed Clerk server-side publishable key |
| `VITE_CLERK_PUBLISHABLE_KEY` | Managed Clerk browser key |

Do not commit `.env` files or place private keys in client-side variables.
