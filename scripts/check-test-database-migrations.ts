import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

export type MigrationJournalEntry = { idx: number; when: number; tag: string };

export function findUnappliedMigrations(
  entries: MigrationJournalEntry[],
  appliedTimestamps: Iterable<string | number | bigint>,
) {
  const applied = new Set(Array.from(appliedTimestamps, String));
  return entries.filter((entry) => !applied.has(String(entry.when)));
}

export function formatUnappliedMigrations(migrations: MigrationJournalEntry[]) {
  const missing = migrations.map(({ idx, tag }) => `  - ${tag} (migration ${idx + 1})`).join("\n");
  return [
    "Database-backed tests stopped: the development database is behind checked-in migrations.",
    "Unapplied migrations:",
    missing,
    "Run `npm run db:migrate` to update the development database, then rerun the tests.",
    "This preflight only reads migration history; it did not apply migrations or change data.",
  ].join("\n");
}

export async function unappliedDatabaseMigrations(
  databaseUrl: string,
  entries: MigrationJournalEntry[],
) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    const tableResult = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists",
    );
    if (!tableResult.rows[0]?.exists) return entries;

    const appliedResult = await pool.query<{ created_at: string | number | bigint }>(
      "SELECT created_at FROM drizzle.__drizzle_migrations",
    );
    return findUnappliedMigrations(entries, appliedResult.rows.map((row) => row.created_at));
  } finally {
    await pool.end();
  }
}

async function runPreflight() {
  if (!process.env.DATABASE_URL) {
    console.log("Database migration preflight skipped: DATABASE_URL is not set; database-backed tests will skip.");
    return;
  }

  const journalPath = resolve("drizzle/meta/_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: MigrationJournalEntry[] };
  const unapplied = await unappliedDatabaseMigrations(process.env.DATABASE_URL, journal.entries);
  if (unapplied.length) {
    console.error(formatUnappliedMigrations(unapplied));
    process.exitCode = 1;
    return;
  }
  console.log(`Database migration preflight passed (${journal.entries.length} checked-in migrations).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPreflight().catch((error: unknown) => {
    console.error(
      `Database migration preflight could not verify the development database: ${error instanceof Error ? error.message : "database check failed"}`,
    );
    process.exitCode = 1;
  });
}
