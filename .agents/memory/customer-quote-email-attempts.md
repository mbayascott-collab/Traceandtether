---
name: Customer quote email retry safety
description: Retry rules and completion ordering for quote emails sent through Gmail.
---

An ambiguous quote email attempt must remain unresolved until the owner explicitly confirms a retry. A provider response may arrive after a confirmed retry has started, so each completion must update only the attempt that initiated it.

**Why:** A timeout or interrupted request does not prove Gmail rejected the message, and a delayed earlier response must not overwrite the newer retry's database result.

**How to apply:** Preserve the sending claim when confirmation is absent. Fence send completion by the saved attempt identity, not only by quote ID or a generic sending status.
