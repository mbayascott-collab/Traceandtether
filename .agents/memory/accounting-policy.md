---
name: Accounting policy
description: Inventory costing and recognition rules confirmed for automated accounting.
---

Use weighted-average inventory costing. Record unpaid sales as receivables and unpaid purchases/import costs as payables; keep journal values in ZMW using the recorded exchange rates. Opening inventory is recorded separately against opening balance equity, not added to the owner's explicitly entered equity balance.

For orders delivered in several batches, record each delivery as its own sale and receivable for the quantities delivered. Customer payments may be recorded later against the order balance.

When import costs are recorded after receipts, leave the share for stock not yet posted in landed-cost clearing. For the already-posted share, estimate the inventory portion from the product's current weighted-average inventory value relative to the weighted-average value of all receipt units; allocate the remainder to cost of goods sold. This is a pooled-cost estimate, not purchase-order lot tracking.

For campaign reporting, allocate posted product-level landed-cost adjustments that reached cost of goods sold across that product's deliveries in proportion to their original recorded delivery costs. Allocate cents deterministically so the full adjustment is counted once across deliveries; do not allocate it to deliveries with no recorded cost basis. Keep this report allocation separate from the source journal and identify it in the report.

**Why:** the user confirmed these choices when asked how automated accounting should treat stock cost and unpaid transactions, then chose separate recognition for each partial delivery. Landed-cost corrections identify the product but not its individual sales, so a stable cost-weighted split is consistent with pooled costing, avoids counting a correction twice, and leaves accounting journals unchanged.

**How to apply:** Maintain balanced source-linked entries, update inventory book value from receipts and allocated import costs, and do not assume cash settlement, tax treatment, or opening balances that have not been recorded. Post sales revenue, receivables, and inventory cost as each delivery is recorded; apply receipts to the resulting order balance. For late import costs, separate unposted receipt amounts before estimating the remaining inventory share under pooled weighted-average costing. For campaign analysis, allocate only the posted cost-of-goods-sold part over all recorded deliveries for that product, preserve cent totals, and explain the method in the report.
