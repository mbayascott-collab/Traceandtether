---
name: Customer quote email retry safety
description: Retry rules and completion ordering for quote emails sent through Gmail.
---

An ambiguous quote email attempt must remain unresolved until the owner explicitly confirms a retry. A provider response may arrive after a confirmed retry has started, so each completion must update only the attempt that initiated it.

**Why:** A timeout or interrupted request does not prove Gmail rejected the message, and a delayed earlier response must not overwrite the newer retry's database result.

**How to apply:** Preserve the sending claim when confirmation is absent. Fence send completion by the saved attempt identity, not only by quote ID or a generic sending status.

The quote sender remains Gmail. Gmail cannot confirm successful delivery through its API, so the user chose to track permanent bounce reports only; a successful Gmail send remains `sent`, not `delivered`.

**Why:** Gmail mailbox change notifications do not provide per-message delivery results, and the user chose not to switch quote sending to a transactional provider.

**How to apply:** Parse only permanent delivery-status failures tied to the current quote send attempt. Do not infer delivery from Gmail's acceptance response or change the sender without the user's direction.
