---
name: Inventory ledger
description: Stock balance and reservation accounting rules for this business platform.
---

On-hand stock is derived from append-only inventory movements; do not store or edit a separate stock total. Reservations reduce available stock without changing on-hand quantity. Received shipment quantities enter stock only through an explicit, idempotent posting action; corrections are new reasoned adjustment movements. Sales orders snapshot their ZMW unit prices, reserve inventory when confirmed, consume those linked reservations when fulfilled, and release them when cancelled.

**Why:** direct balance edits or implicit shipment posting would make stock changes difficult to audit or reconcile; price snapshots and order-linked reservations also protect confirmed orders from later catalogue changes or unrelated reservation actions.

**How to apply:** Keep physical receipts, adjustments, and reservation fulfillment in the movement ledger. Keep active reservations separate, validate adjustments against reserved units, and prevent a shipment receipt from being posted twice or reduced after posting. Handle sales-order reservations through the order lifecycle, not generic reservation controls.
