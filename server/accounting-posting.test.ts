import assert from "node:assert/strict";
import test from "node:test";
import { cents, formatCents, journalLinesAreBalanced } from "./accounting-posting";

test("parses and formats ZMW using exact minor units", () => {
  assert.equal(cents("123456.78"), 12_345_678n);
  assert.equal(formatCents(12_345_678n), "123456.78");
});

test("accepts only positive balanced journal lines", () => {
  assert.equal(journalLinesAreBalanced([
    { accountKey: "inventory", debitZmw: "120.50" },
    { accountKey: "accounts_payable", creditZmw: "120.50" },
  ]), true);
  assert.equal(journalLinesAreBalanced([
    { accountKey: "inventory", debitZmw: "120.50" },
    { accountKey: "accounts_payable", creditZmw: "120.49" },
  ]), false);
  assert.equal(journalLinesAreBalanced([]), false);
});
