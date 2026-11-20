---
name: Payment reminder balance snapshots
description: Prevent receipts and returns from changing a balance while its reminder is being sent.
---

Keep the sales-order row locked from the reminder balance read through Gmail's response and persistence of the send result. Customer receipt and return posting must use the same row lock.

**Why:** An email cannot be corrected after Gmail accepts it. If a receipt or return commits while a send is in progress, the customer can receive an amount that no longer matches the agreed send point.

**How to apply:** When changing reminder delivery, customer receipts, or returns, preserve the shared order-lock boundary. Account for the tradeoff that the database transaction stays open during the provider call; keep provider timeouts bounded.
