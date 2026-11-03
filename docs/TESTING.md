# Testing

## Automated checks

Run:

- `npm test` — unit tests for exact-decimal profitability calculations and product, supplier, and quotation input validation.
- `npm run build` — Vite production build and TypeScript type-check.

Database migration application is verified separately with `npm run db:migrate` against the development database.

## Manual verification

1. Confirm `INITIAL_ADMIN_EMAIL` matches the owner's verified Clerk sign-in email.
2. Start the app with `npm run dev`.
3. Create/sign in to a Clerk account using that exact email and complete verification.
4. Open Products, create a draft product with a unique SKU, supplier reference, purchase currency/price, estimated landed cost in ZMW, and selling price in ZMW.
5. Confirm the saved product appears after refresh and the estimated gross profit/margin match the entered prices.
6. Edit the product and change its status to active. Confirm a positive ZMW selling price is required.
7. Create a category, assign it to a product, then rename or deactivate it.
8. Search by product name, SKU, or supplier reference; filter by status/category; test pagination if there are more than 25 records.
9. Try a duplicate SKU, negative amount, malformed currency code, and negative reorder threshold; each should be rejected with an error.
10. Sign in with a different verified email. Confirm the account is denied access to administration data.

## Limitations

The public landing page was visually checked. Health and unauthenticated product, supplier, and quotation API behavior were checked. A temporary supplier and quotation were created, read through a separate database connection, edited, and removed. The signed-in UI and API flows were not verified in a real owner browser session; the preview capture is signed out.
