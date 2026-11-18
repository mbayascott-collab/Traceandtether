import assert from "node:assert/strict";
import test from "node:test";
import {
  accountingReportExportRows,
  calculateAccountingReports,
  type AccountingReportAccount,
  type AccountingReportLine,
} from "../shared/accounting-reports";
import { journalLinesAreBalanced } from "./accounting-posting";

const accounts: AccountingReportAccount[] = [
  { id: 1, code: "1010", name: "Cash on hand", type: "asset" },
  { id: 2, code: "1100", name: "Inventory", type: "asset" },
  { id: 3, code: "2100", name: "Accounts payable", type: "liability" },
  { id: 4, code: "3000", name: "Owner equity", type: "equity" },
  { id: 5, code: "4100", name: "Sales revenue", type: "income" },
  { id: 6, code: "5100", name: "Cost of goods sold", type: "expense" },
  { id: 7, code: "6300", name: "Rent expense", type: "expense" },
];

type FixtureLine = AccountingReportLine & { accountKey: string };
const accountIds = new Map([
  ["cash", 1], ["inventory", 2], ["payable", 3], ["equity", 4],
  ["sales", 5], ["cogs", 6], ["rent", 7],
]);

function journal(entryDate: string, parts: Array<[string, "debit" | "credit", string]>): FixtureLine[] {
  const postingLines = parts.map(([accountKey, side, amount]) => ({
    accountKey,
    ...(side === "debit" ? { debitZmw: amount } : { creditZmw: amount }),
  }));
  assert.equal(journalLinesAreBalanced(postingLines), true, `fixture journal on ${entryDate} must balance`);
  return parts.map(([accountKey, side, amount]) => ({
    accountId: accountIds.get(accountKey)!,
    accountKey,
    entryDate,
    debitZmw: side === "debit" ? amount : "0.00",
    creditZmw: side === "credit" ? amount : "0.00",
  }));
}

const knownBooks: FixtureLine[] = [
  ...journal("2025-12-31", [
    ["cash", "debit", "1000.00"], ["inventory", "debit", "500.00"], ["equity", "credit", "1500.00"],
  ]),
  ...journal("2026-01-15", [
    ["cash", "debit", "90.00"], ["sales", "credit", "90.00"],
  ]),
  ...journal("2026-01-20", [
    ["rent", "debit", "20.00"], ["cash", "credit", "20.00"],
  ]),
  ...journal("2026-02-10", [
    ["cash", "debit", "500.00"], ["sales", "credit", "500.00"],
  ]),
  ...journal("2026-02-11", [
    ["cogs", "debit", "200.00"], ["inventory", "credit", "200.00"],
  ]),
  ...journal("2026-03-05", [
    ["rent", "debit", "100.00"], ["cash", "credit", "100.00"],
  ]),
  ...journal("2026-04-01", [
    ["cash", "debit", "300.00"], ["sales", "credit", "300.00"],
  ]),
  ...journal("2026-04-02", [
    ["rent", "debit", "50.00"], ["cash", "credit", "50.00"],
  ]),
];

test("year-end reports use the requested period and balance through its end date", () => {
  const reports = calculateAccountingReports(accounts, knownBooks, "2026-02-01", "2026-03-31");

  assert.equal(reports.incomeStatement.find((row) => row.type === "income")?.amountZmw, "500.00");
  assert.equal(reports.incomeStatement.find((row) => row.code === "5100")?.amountZmw, "200.00");
  assert.equal(reports.incomeStatement.find((row) => row.code === "6300")?.amountZmw, "100.00");
  assert.deepEqual(
    [reports.totals.incomeZmw, reports.totals.expensesZmw, reports.totals.netIncomeZmw],
    ["500.00", "300.00", "200.00"],
  );

  assert.equal(reports.trialBalance.find((row) => row.code === "4100")?.creditZmw, "590.00");
  assert.equal(reports.trialBalance.find((row) => row.code === "6300")?.debitZmw, "120.00");
  assert.equal(reports.totals.trialDebitsZmw, reports.totals.trialCreditsZmw);

  const assets = reports.balanceSheet
    .filter((row) => row.type === "asset")
    .reduce((sum, row) => sum + Number(row.amountZmw), 0);
  const liabilitiesAndEquity = reports.balanceSheet
    .filter((row) => row.type === "liability" || row.type === "equity")
    .reduce((sum, row) => sum + Number(row.amountZmw), 0);
  assert.equal(reports.balanceSheet.at(-1)?.name, "Accumulated earnings (not closed)");
  assert.equal(reports.balanceSheet.at(-1)?.amountZmw, "270.00");
  assert.equal(assets, 1770);
  assert.equal(liabilitiesAndEquity, 1770);
});

test("report export rows exactly reflect the displayed report rows", () => {
  const reports = calculateAccountingReports(accounts, knownBooks, "2026-02-01", "2026-03-31");
  const exports = accountingReportExportRows(reports);

  assert.deepEqual(exports.trialBalance.slice(1), reports.trialBalance.map((row) => [
    row.code, row.name, row.type, row.debitZmw, row.creditZmw, row.balanceZmw,
  ]));
  assert.deepEqual(exports.incomeStatement.slice(1), reports.incomeStatement.map((row) => [
    row.code, row.name, row.type, row.amountZmw,
  ]));
  assert.deepEqual(exports.balanceSheet.slice(1), reports.balanceSheet.map((row) => [
    row.code, row.name, row.type, row.amountZmw,
  ]));
});
