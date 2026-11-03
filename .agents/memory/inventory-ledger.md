---
name: Inventory ledger
description: Stock balance and reservation accounting rules for this business platform.
---

On-hand stock is derived from append-only inventory movements; do not store or edit a separate stock total. Reservations reduce available stock without changing on-hand quantity. Received shipment quantities enter stock only through an explicit, idempotent posting action; corrections are new reasoned adjustment movements.

**Why:** the user asked for traceable inventory records, and direct balance edits or implicit shipment posting would make stock changes difficult to audit or reconcile.

**How to apply:** Keep physical receipts, adjustments, and reservation fulfillment in the movement ledger. Keep active reservations separate, validate adjustments against reserved units, and prevent a shipment receipt from being posted twice or reduced after posting.
