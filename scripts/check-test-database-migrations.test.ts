import assert from "node:assert/strict";
import test from "node:test";
import {
  findUnappliedMigrations,
  formatUnappliedMigrations,
  type MigrationJournalEntry,
} from "./check-test-database-migrations";

const entries: MigrationJournalEntry[] = [
  { idx: 0, when: 1000, tag: "0000_initial" },
  { idx: 1, when: 2000, tag: "0001_customers" },
  { idx: 2, when: 3000, tag: "0002_payments" },
];

test("database migration preflight identifies only unapplied checked-in migrations", () => {
  assert.deepEqual(findUnappliedMigrations(entries, ["1000", 3000n]), [entries[1]]);
  assert.deepEqual(findUnappliedMigrations(entries, [1000, 2000, 3000]), []);
});

test("database migration preflight explains how to update without changing data itself", () => {
  const message = formatUnappliedMigrations([entries[1]]);
  assert.match(message, /0001_customers/);
  assert.match(message, /npm run db:migrate/);
  assert.match(message, /did not apply migrations or change data/i);
});
