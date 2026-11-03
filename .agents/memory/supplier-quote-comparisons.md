---
name: Supplier quote comparisons
description: Currency and cost boundaries for comparing supplier offers.
---

Supplier quotes must remain paired with their stated source currency. Comparisons should not imply a cross-currency ranking or landed cost unless exchange rates, freight, and allocation rules are sourced and defined. Purchase orders and import expenses use explicit, recorded user-entered FX rates; allocate expenses by declared line value or quantity, and keep calculated costs separate from product estimates.

**Why:** no exchange-rate provider or logistics-cost source is configured, so conversions need an auditable rate entered for the specific purchase rather than inferred market data.

**How to apply:** Compare quoted unit price only within the same currency, while showing MOQ, lead time, validity, and terms separately. Use the order's recorded rate for its item cost and each expense's recorded rate for its ZMW conversion; do not silently overwrite the product's separate estimate.
