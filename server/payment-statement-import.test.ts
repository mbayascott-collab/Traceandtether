import test from "node:test";
import assert from "node:assert/strict";
import {
  findDuplicateStatementRows, normalizeStatementText, statementImportFingerprint, statementLineDuplicateKey,
  type StatementImportLine,
} from "./payment-statement-import";

const line = (overrides: Partial<StatementImportLine> = {}): StatementImportLine => ({
  transactionDate: "2026-11-01",
  flow: "in",
  amountZmw: "125.50",
  description: "Customer payment",
  reference: " REF-001 ",
  ...overrides,
});

test("statement text matching ignores letter case and repeated whitespace", () => {
  assert.equal(normalizeStatementText("  Ref \t  001 "), "ref 001");
});

test("identical import fingerprints do not depend on row order or amount formatting", () => {
  const first = line();
  const second = line({ transactionDate: "2026-11-02", amountZmw: "40.00", reference: "REF-002" });
  assert.equal(
    statementImportFingerprint([first, second]),
    statementImportFingerprint([second, line({ amountZmw: "125.5", description: " customer   PAYMENT ", reference: "ref-001" })]),
  );
});

test("transaction duplicate matching keeps date, flow, amount, and reference significant", () => {
  const base = line();
  assert.equal(statementLineDuplicateKey(base), statementLineDuplicateKey(line({ description: "Other narration" })));
  assert.notEqual(statementLineDuplicateKey(base), statementLineDuplicateKey(line({ flow: "out" })));
  assert.notEqual(statementLineDuplicateKey(base), statementLineDuplicateKey(line({ amountZmw: "125.51" })));
  assert.notEqual(statementLineDuplicateKey(base), statementLineDuplicateKey(line({ transactionDate: "2026-11-02" })));
  assert.notEqual(statementLineDuplicateKey(base), statementLineDuplicateKey(line({ reference: "REF-002" })));
});

test("duplicate review flags prior transactions and repeated rows inside one file", () => {
  const prior = line();
  const separate = line({ transactionDate: "2026-11-02", reference: "REF-002" });
  assert.deepEqual(
    findDuplicateStatementRows([line({ description: "Different narration" }), separate, separate], [prior]),
    [true, true, true],
  );
  assert.deepEqual(findDuplicateStatementRows([separate], [prior]), [false]);
});
