---
name: Trusted proxy address handling
description: Safe visitor IP extraction for public-shop limits behind Replit's preview proxy.
---

The application trusts one proxy hop when deriving visitor IPs. A live Replit preview request carrying two caller-chosen `X-Forwarded-For` values did not use either value as the public-shop challenge IP. Keep the actual client address private; do not log or expose it.

**Why:** A direct request through the preview confirmed the tested forged values were not selected as the limit key, while request-level tests confirmed distinct real-address values keep separate limits.

**How to apply:** Keep the shared proxy-hop setting used by the app and integration tests aligned. Re-run the request-level spoof-resistance check if the deployment or proxy topology changes; do not assume development and production proxy chains are identical.
