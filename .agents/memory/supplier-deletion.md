---
name: Supplier deletion and history
description: When supplier records can be removed versus retained.
---

Allow hard deletion only for suppliers with no quotations. If a supplier has quotation history, preserve that history and have the owner deactivate the supplier instead.

**Why:** quotation records are business history; removing their supplier would break traceability.

**How to apply:** Check for quotation references on the server, retain a restrictive database foreign key, and explain that deactivation is the alternative when deletion is blocked.
