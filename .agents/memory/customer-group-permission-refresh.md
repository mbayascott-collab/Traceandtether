---
name: Customer group permission refreshes
description: Clear sensitive customer-group state when a live permission refresh reports access was revoked.
---

When a customer-group permission refresh no longer grants owner capabilities, clear the same group, member, selection, form, and review state as a failed refresh. A successful response can still represent a role downgrade.

**Why:** A user can lose owner access while a marketing tab remains open. Hiding controls alone can leave customer details or owner-only review panels in component state.

**How to apply:** Treat missing owner permissions in a refresh response as revocation, not as an ordinary data update. Cover the transition from loaded owner state to restricted access in tests.
