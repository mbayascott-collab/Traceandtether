import assert from "node:assert/strict";
import test from "node:test";
import { buildOpeningBalanceLines, cents, formatCents, journalLinesAreBalanced } from "./accounting-posting";

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

test("opening balances balance with a temporary equity offset", () => {
  const lines = buildOpeningBalanceLines({
    cashBankZmw: "100.00",
    receivablesZmw: "25.50",
    payablesZmw: "40.00",
    loansPayableZmw: "0.00",
    ownerEquityZmw: "50.00",
  });
  assert.equal(journalLinesAreBalanced(lines), true);
  assert.deepEqual(lines.at(-1), {
    accountKey: "opening_balance_equity",
    creditZmw: "35.50",
    description: "Temporary balancing amount; review after opening stock is recorded",
  });
});

test("opening balance equity can have a debit balance when credits exceed assets", () => {
  const lines = buildOpeningBalanceLines({
    cashBankZmw: "10.00",
    receivablesZmw: "0.00",
    payablesZmw: "0.00",
    loansPayableZmw: "0.00",
    ownerEquityZmw: "15.00",
  });
  assert.equal(journalLinesAreBalanced(lines), true);
  assert.equal(lines.at(-1)?.debitZmw, "5.00");
});
