---
name: Drizzle migration history location
description: Where this project's Drizzle migrator records applied migrations.
---

The project's Drizzle migration history table is `drizzle.__drizzle_migrations`, not `public.__drizzle_migrations`.

**Why:** The migration preflight initially treated every migration as unapplied when it checked the public schema, although the development database already had all migrations recorded in the `drizzle` schema.

**How to apply:** Any script or diagnostic that compares checked-in Drizzle migrations with the database should read the migration history from the `drizzle` schema and remain read-only unless the user explicitly requests a migration.
