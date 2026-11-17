import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpeningBalanceLines, cashAccountKeyForMethod, cents, formatCents, journalLinesAreBalanced,
  operatingExpenseAccountKey,
} from "./accounting-posting";

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
    cashOnHandZmw: "30.00",
    bankZmw: "50.00",
    mobileMoneyZmw: "20.00",
    otherFundsZmw: "0.00",
    receivablesZmw: "25.50",
    payablesZmw: "40.00",
    loansPayableZmw: "0.00",
    ownerEquityZmw: "50.00",
  });
  assert.equal(journalLinesAreBalanced(lines), true);
  assert.deepEqual(lines.slice(0, 3).map((line) => [line.accountKey, line.debitZmw]), [
    ["cash_on_hand", "30.00"],
    ["bank_account", "50.00"],
    ["mobile_money", "20.00"],
  ]);
  assert.deepEqual(lines.at(-1), {
    accountKey: "opening_balance_equity",
    creditZmw: "35.50",
    description: "Temporary balancing amount; review after opening stock is recorded",
  });
});

test("opening balance equity can have a debit balance when credits exceed assets", () => {
  const lines = buildOpeningBalanceLines({
    cashOnHandZmw: "10.00",
    bankZmw: "0.00",
    mobileMoneyZmw: "0.00",
    otherFundsZmw: "0.00",
    receivablesZmw: "0.00",
    payablesZmw: "0.00",
    loansPayableZmw: "0.00",
    ownerEquityZmw: "15.00",
  });
  assert.equal(journalLinesAreBalanced(lines), true);
  assert.equal(lines.at(-1)?.debitZmw, "5.00");
});

test("maps each payment method to its own balance account", () => {
  assert.equal(cashAccountKeyForMethod("cash"), "cash_on_hand");
  assert.equal(cashAccountKeyForMethod("bank_transfer"), "bank_account");
  assert.equal(cashAccountKeyForMethod("mobile_money"), "mobile_money");
  assert.equal(cashAccountKeyForMethod("other"), "other_funds");
});

test("maps ordinary expense categories to the correct report accounts", () => {
  assert.equal(operatingExpenseAccountKey("rent"), "rent_expense");
  assert.equal(operatingExpenseAccountKey("office_supplies"), "office_supplies_expense");
  assert.equal(operatingExpenseAccountKey("utilities"), "utilities_expense");
  assert.equal(operatingExpenseAccountKey("other"), "other_operating_expense");
});
