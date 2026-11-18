---
name: Payment aging defaults
description: Why payment due dates default to recorded transaction dates when no terms are configured.
---

For customer balances, use the latest delivery date as the default due date; for supplier balances, use the purchase-order date. Let the owner override either date. Do not infer a payment term from free-text supplier terms or invent a customer term.

**Why:** the business has no structured customer payment terms, and supplier terms are free text; guessing could misstate when a balance is overdue.

**How to apply:** If structured payment terms are added later, use them only to derive a date when the owner has not set an explicit due date.
