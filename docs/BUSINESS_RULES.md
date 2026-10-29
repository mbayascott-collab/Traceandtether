# Business rules

## Product pricing and profitability

- Purchase prices are recorded in the selected supplier currency.
- Selling prices and estimated landed costs are recorded in ZMW.
- The application does not convert purchase currency to ZMW; the user enters or later records the ZMW landed-cost estimate separately.
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

- This milestone does not reserve or decrement inventory.
- It does not create purchase orders, shipments, customer orders, payments, refunds, tax calculations, or accounting entries.
- It does not estimate tax/customs rates or automatically select suppliers.
