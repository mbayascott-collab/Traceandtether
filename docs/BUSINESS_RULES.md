# Business rules

## Product pricing and profitability

- Purchase prices are recorded in the selected supplier currency.
- Selling prices and estimated landed costs are recorded in ZMW.
- Product purchase prices and supplier quotations remain in their recorded currencies. Purchase orders and import expenses use an explicit, user-entered ZMW exchange rate for landed-cost calculations; rates are never inferred.
- Landed-cost allocations are calculated per purchase-order line using each expense's recorded value or quantity basis. They do not overwrite the product's separately maintained estimated landed cost.
- Prices are optional for draft products and cannot be negative.
- An active product must have a positive selling price.
- Estimated gross profit per unit = selling price in ZMW minus estimated landed cost per unit in ZMW.
- Estimated gross margin = estimated gross profit divided by selling price, multiplied by 100, when selling price is positive.
- Gross margin is not markup, contribution, operating profit, or net profit.
- Profitability calculations use decimal strings and integer minor units; stored monetary amounts use PostgreSQL `NUMERIC(14,2)`.
- Product-page profitability remains an estimate. Accounting cost of goods sold uses weighted-average book value; stock requires an opening value or a recorded receipt to be included accurately.

## Product and category lifecycle

- SKU matching is case-insensitive; stored SKUs are normalized to uppercase.
- Category-name matching is case-insensitive.
- Products can be draft, active, or inactive. Inactivation preserves the product and its references.
- Categories can be active or inactive. Inactivation preserves their product relationships.
- Product and category mutations require owner authorization and server validation.
- Product create/edit and audit history are committed together.

## Scope boundaries

- Stock-on-hand is derived from append-only opening-stock, receipt, adjustment, and reservation-fulfillment movements. Reservations reduce available stock but do not change on-hand stock until fulfilled.
- Sales orders snapshot explicit ZMW unit prices. Confirming an order reserves available stock; fulfillment records the stock-out movement. Unpaid sales are recorded as receivables and unpaid purchases/import costs as payables.
- Automated journal entries are immutable, balanced, and linked to their source event. Opening stock adds the entered average ZMW cost to inventory and credits owner equity; it is not sales income. Inventory receipts add ZMW purchase costs and pre-receipt allocated import costs to inventory; cost of sales uses weighted-average inventory book value. Import expenses entered after partial or full stock posting may leave an amount in landed-cost clearing for review.
- Opening stock quantity and value can be entered once per product. Opening cash, receivables, payables, payment settlement, tax, refunds, bank reconciliation, and accountant-reviewed financial statements are not implemented.
- Public shop order requests are saved as draft sales orders after server-side price and stock checks. They do not reserve stock or collect payment; an owner must confirm stock, delivery, and payment before treating the order as accepted. Public catalog responses include only active, priced, available products and customer-facing fields.
- Use manual order requests until Shopify is affordable; Shopify can be integrated later as the storefront and checkout system without exposing the private supplier and cost records.
- It does not estimate tax/customs rates or automatically select suppliers.
- Supplier records are internal sourcing records, not seller accounts.
- Quotations retain the supplier's stated currency. Comparisons do not convert currencies or infer freight, tax, or landed costs.
- Marketing expenses retain the entered currency and explicit ZMW exchange rate. Unpaid costs post to marketing expense and accounts payable; costs marked paid credit cash and bank. Campaign budgets are planning limits, not accounting balances.
- Campaign attribution is explicitly assigned by the owner to a sales order; no touchpoint is inferred. Campaign sales reports include fulfilled orders by order date, while customer groups use lifetime fulfilled-order counts.
- Profitability reports separate recorded cost of sales from estimates based on current product cost estimates. They do not represent net profit; products without an opening value or recorded receipts can have incomplete costs.
- Replenishment suggestions trigger below the product's configured reorder level and subtract active reservations and unstocked quantities on non-cancelled purchase orders. Suggested quantity restores stock to that reorder level; recent 90-day sales are context, not a demand forecast.
- The cash forecast assumes all current receivables and payables settle within 30 days. It assumes no new sales or costs and may be incomplete until opening cash balances are recorded.
- Customer quotes save ZMW price snapshots. Only accepted, unexpired quotes can be converted, once, into draft sales orders; stock is reserved only when the order is confirmed.
