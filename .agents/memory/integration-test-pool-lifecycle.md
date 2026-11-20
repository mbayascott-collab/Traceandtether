---
name: Shared test database pool lifecycle
description: Keep integration tests from closing a database pool that later tests in the same module still use.
---

When tests in one module import the shared database module, keep its pool open across the module's tests and close it in one module-level teardown hook.

**Why:** the database module is cached, so ending its shared pool in one test leaves later tests with a closed pool and causes cascading failures.

**How to apply:** remove per-test `pool.end()` calls from shared-pool integration tests; register one `after()` cleanup hook for the module.
