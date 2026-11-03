# Security

## Authentication and authorization

- Sign-in uses Replit-managed Clerk. Credentials and session handling are managed by Clerk; the application does not store passwords.
- Clerk middleware runs on the Express server, and API authorization is checked server-side.
- The first owner must use a verified primary email exactly matching `INITIAL_ADMIN_EMAIL`.
- An unapproved account can sign in but cannot access product, category, or other administration APIs.
- The first owner record is created only after email verification and allowlist matching. The server also checks the stored owner role.
- Do not grant owner access to the first account that happens to register.
- `INITIAL_ADMIN_EMAIL` is a non-secret access setting. Do not expose it through a `VITE_` variable.

## Data protection

- The browser sends same-origin requests and does not receive database credentials or the Clerk secret key.
- Product APIs validate all submitted fields server-side.
- Express applies a bounded JSON request size and returns generic unexpected-error messages.
- Private supplier references and cost information are only served from owner-protected routes.
- Supplier profiles and quotations are also private owner-only data; suppliers do not receive accounts or direct access.
- No product images or private files are stored in temporary application storage.
- Logs do not include passwords, tokens, or product/customer data.

## Financial record handling

- Monetary database columns use `NUMERIC(14,2)`.
- Product creates and edits are audited transactionally.
- Product records are deactivated rather than permanently deleted.
- Accounting records and inventory movements do not yet exist in this phase.

## Remaining security work

- Employee invitations and configurable permissions are planned for a later phase.
- Rate limiting, formal backup/recovery procedures, and a broader production security review remain part of production readiness.
