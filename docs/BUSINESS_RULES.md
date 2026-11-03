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
- Profitability shown in this milestone is explicitly estimated; actual landed cost and cost of goods sold are not implemented.

## Product and category lifecycle

- SKU matching is case-insensitive; stored SKUs are normalized to uppercase.
- Category-name matching is case-insensitive.
- Products can be draft, active, or inactive. Inactivation preserves the product and its references.
- Categories can be active or inactive. Inactivation preserves their product relationships.
- Product and category mutations require owner authorization and server validation.
- Product create/edit and audit history are committed together.

## Scope boundaries

- Stock-on-hand is derived from append-only receipt, adjustment, and reservation-fulfillment movements. Reservations reduce available stock but do not change on-hand stock until fulfilled.
- Sales orders snapshot explicit ZMW unit prices. Confirming an order reserves available stock; fulfillment records the stock-out movement. This does not create payments, refunds, tax calculations, accounting entries, or multi-location stock tracking.
- It does not estimate tax/customs rates or automatically select suppliers.
- Supplier records are internal sourcing records, not seller accounts.
- Quotations retain the supplier's stated currency. Comparisons do not convert currencies or infer freight, tax, or landed costs.
