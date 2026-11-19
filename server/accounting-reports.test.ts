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

test("income and expenses include both report boundary dates but exclude adjacent dates", () => {
  const boundaryBooks: FixtureLine[] = [
    ...journal("2026-01-31", [
      ["cash", "debit", "100.00"], ["sales", "credit", "100.00"],
      ["rent", "debit", "10.00"], ["cash", "credit", "10.00"],
    ]),
    ...journal("2026-02-01", [
      ["cash", "debit", "20.00"], ["sales", "credit", "20.00"],
      ["rent", "debit", "2.00"], ["cash", "credit", "2.00"],
    ]),
    ...journal("2026-03-31", [
      ["cash", "debit", "30.00"], ["sales", "credit", "30.00"],
      ["rent", "debit", "3.00"], ["cash", "credit", "3.00"],
    ]),
    ...journal("2026-04-01", [
      ["cash", "debit", "200.00"], ["sales", "credit", "200.00"],
      ["rent", "debit", "20.00"], ["cash", "credit", "20.00"],
    ]),
  ];
  const reports = calculateAccountingReports(accounts, boundaryBooks, "2026-02-01", "2026-03-31");

  assert.deepEqual(
    [reports.totals.incomeZmw, reports.totals.expensesZmw, reports.totals.netIncomeZmw],
    ["50.00", "5.00", "45.00"],
  );
  assert.equal(reports.incomeStatement.find((row) => row.code === "4100")?.amountZmw, "50.00");
  assert.equal(reports.incomeStatement.find((row) => row.code === "6300")?.amountZmw, "5.00");
});

test("year-end reports keep accumulated losses negative while the balance sheet balances", () => {
  const lossYear: FixtureLine[] = [
    ...journal("2025-12-31", [
      ["cash", "debit", "1000.00"], ["payable", "credit", "30.00"], ["equity", "credit", "970.00"],
    ]),
    ...journal("2026-02-10", [
      ["cash", "debit", "100.00"], ["sales", "credit", "100.00"],
    ]),
    ...journal("2026-03-05", [
      ["rent", "debit", "80.00"], ["cash", "credit", "80.00"],
    ]),
    ...journal("2026-04-02", [
      ["cogs", "debit", "70.00"], ["cash", "credit", "70.00"],
    ]),
  ];
  const reports = calculateAccountingReports(accounts, lossYear, "2026-01-01", "2026-12-31");

  assert.deepEqual(
    [reports.totals.incomeZmw, reports.totals.expensesZmw, reports.totals.netIncomeZmw],
    ["100.00", "150.00", "-50.00"],
  );
  assert.equal(reports.balanceSheet.at(-1)?.name, "Accumulated earnings (not closed)");
  assert.equal(reports.balanceSheet.at(-1)?.amountZmw, "-50.00");
  const exportedBalanceSheet = accountingReportExportRows(reports).balanceSheet;
  assert.equal(exportedBalanceSheet.at(-1)?.[3], "-50.00");

  const assets = reports.balanceSheet
    .filter((row) => row.type === "asset")
    .reduce((sum, row) => sum + Number(row.amountZmw), 0);
  const liabilitiesAndEquity = reports.balanceSheet
    .filter((row) => row.type === "liability" || row.type === "equity")
    .reduce((sum, row) => sum + Number(row.amountZmw), 0);
  assert.equal(assets, 950);
  assert.equal(liabilitiesAndEquity, 950);
});

test("year-end reports keep earlier gains in accumulated earnings after a current-year loss", () => {
  const profitablePriorYearThenLoss: FixtureLine[] = [
    ...journal("2024-12-31", [
      ["cash", "debit", "1000.00"], ["equity", "credit", "1000.00"],
    ]),
    ...journal("2025-06-30", [
      ["cash", "debit", "400.00"], ["sales", "credit", "400.00"],
    ]),
    ...journal("2025-12-31", [
      ["rent", "debit", "100.00"], ["cash", "credit", "100.00"],
    ]),
    ...journal("2026-03-31", [
      ["cash", "debit", "100.00"], ["sales", "credit", "100.00"],
    ]),
    ...journal("2026-09-30", [
      ["rent", "debit", "150.00"], ["cash", "credit", "150.00"],
    ]),
  ];
  const reports = calculateAccountingReports(
    accounts,
    profitablePriorYearThenLoss,
    "2026-01-01",
    "2026-12-31",
  );

  assert.deepEqual(
    [reports.totals.incomeZmw, reports.totals.expensesZmw, reports.totals.netIncomeZmw],
    ["100.00", "150.00", "-50.00"],
  );
  assert.equal(reports.incomeStatement.find((row) => row.code === "4100")?.amountZmw, "100.00");
  assert.equal(reports.incomeStatement.find((row) => row.code === "6300")?.amountZmw, "150.00");
  assert.equal(reports.balanceSheet.at(-1)?.name, "Accumulated earnings (not closed)");
  assert.equal(reports.balanceSheet.at(-1)?.amountZmw, "250.00");
  assert.equal(reports.totals.trialDebitsZmw, reports.totals.trialCreditsZmw);

  const assets = reports.balanceSheet
    .filter((row) => row.type === "asset")
    .reduce((sum, row) => sum + Number(row.amountZmw), 0);
  const liabilitiesAndEquity = reports.balanceSheet
    .filter((row) => row.type === "liability" || row.type === "equity")
    .reduce((sum, row) => sum + Number(row.amountZmw), 0);
  assert.equal(assets, 1250);
  assert.equal(liabilitiesAndEquity, 1250);
});

test("opening-balance reversal remains in history while reports use the corrected replacement", () => {
  const openingAndCorrections: AccountingReportLine[] = [
    { accountId: 1, entryDate: "2025-12-31", debitZmw: "1000.00", creditZmw: "0.00" },
    { accountId: 4, entryDate: "2025-12-31", debitZmw: "0.00", creditZmw: "1000.00" },
    { accountId: 1, entryDate: "2026-01-10", debitZmw: "0.00", creditZmw: "1000.00" },
    { accountId: 4, entryDate: "2026-01-10", debitZmw: "1000.00", creditZmw: "0.00" },
    { accountId: 1, entryDate: "2026-01-11", debitZmw: "800.00", creditZmw: "0.00" },
    { accountId: 4, entryDate: "2026-01-11", debitZmw: "0.00", creditZmw: "800.00" },
  ];
  const reports = calculateAccountingReports(accounts, openingAndCorrections, "2026-01-01", "2026-12-31");

  assert.equal(reports.trialBalance.find((row) => row.code === "1010")?.balanceZmw, "800.00");
  assert.equal(reports.trialBalance.find((row) => row.code === "3000")?.balanceZmw, "800.00");
  assert.equal(reports.totals.trialDebitsZmw, reports.totals.trialCreditsZmw);
  assert.equal(openingAndCorrections.length, 6, "the original, reversal, and replacement lines all remain reportable");
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

test("cash, bank, and mobile-money balances remain separate in reports and exports", () => {
  const fundAccounts: AccountingReportAccount[] = [
    { id: 1, code: "1000", name: "Cash and bank (previously combined)", type: "asset" },
    { id: 2, code: "1010", name: "Cash on hand", type: "asset" },
    { id: 3, code: "1020", name: "Bank account", type: "asset" },
    { id: 4, code: "1030", name: "Mobile money", type: "asset" },
    { id: 5, code: "3000", name: "Owner equity", type: "equity" },
  ];
  const fundLines: AccountingReportLine[] = [
    { accountId: 1, entryDate: "2026-01-01", debitZmw: "250.00", creditZmw: "0.00" },
    { accountId: 2, entryDate: "2026-01-01", debitZmw: "30.00", creditZmw: "0.00" },
    { accountId: 3, entryDate: "2026-01-01", debitZmw: "50.00", creditZmw: "0.00" },
    { accountId: 4, entryDate: "2026-01-01", debitZmw: "20.00", creditZmw: "0.00" },
    { accountId: 5, entryDate: "2026-01-01", debitZmw: "0.00", creditZmw: "350.00" },
  ];
  const reports = calculateAccountingReports(fundAccounts, fundLines, "2026-01-01", "2026-12-31");
  const trialByCode = new Map(reports.trialBalance.map((row) => [row.code, row]));
  const sheetByCode = new Map(reports.balanceSheet.map((row) => [row.code, row]));

  assert.deepEqual(
    ["1010", "1020", "1030"].map((code) => trialByCode.get(code)?.balanceZmw),
    ["30.00", "50.00", "20.00"],
  );
  assert.deepEqual(
    ["1010", "1020", "1030"].map((code) => sheetByCode.get(code)?.amountZmw),
    ["30.00", "50.00", "20.00"],
  );
  assert.equal(trialByCode.get("1000")?.balanceZmw, "250.00");
  assert.equal(sheetByCode.get("1000")?.amountZmw, "250.00");

  const exports = accountingReportExportRows(reports);
  const exportedBalances = new Map(exports.balanceSheet.slice(1).map(([code, , , amount]) => [code, amount]));
  assert.deepEqual(
    ["1010", "1020", "1030"].map((code) => exportedBalances.get(code)),
    ["30.00", "50.00", "20.00"],
  );
  assert.equal(exportedBalances.get("1000"), "250.00");
});
