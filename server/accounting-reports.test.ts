import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express, { type RequestHandler } from "express";
import {
  accountingReportExportRows,
  calculateAccountingReports,
  findExpenseJournalWarnings,
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
  { id: 8, code: "1020", name: "Bank account", type: "asset" },
  { id: 9, code: "1030", name: "Mobile money", type: "asset" },
  { id: 10, code: "1040", name: "Other funds", type: "asset" },
  { id: 11, code: "1200", name: "Accounts receivable", type: "asset" },
];

type FixtureLine = AccountingReportLine & { accountKey: string };
const accountIds = new Map([
  ["cash", 1], ["inventory", 2], ["payable", 3], ["equity", 4],
  ["sales", 5], ["cogs", 6], ["rent", 7], ["receivables", 11],
  ["bank", 8], ["mobile_money", 9], ["other_funds", 10],
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
  assert.deepEqual(reports.balanceSheetReconciliation, {
    assetsZmw: "1770.00",
    liabilitiesAndEquityZmw: "1770.00",
    differenceZmw: "0.00",
    isBalanced: true,
  });
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

test("single-day reports include that date's income and expenses but exclude adjacent dates", () => {
  const dailyBooks: FixtureLine[] = [
    ...journal("2026-02-09", [
      ["cash", "debit", "100.00"], ["sales", "credit", "100.00"],
      ["rent", "debit", "10.00"], ["cash", "credit", "10.00"],
    ]),
    ...journal("2026-02-10", [
      ["cash", "debit", "25.00"], ["sales", "credit", "25.00"],
      ["rent", "debit", "4.00"], ["cash", "credit", "4.00"],
    ]),
    ...journal("2026-02-11", [
      ["cash", "debit", "200.00"], ["sales", "credit", "200.00"],
      ["rent", "debit", "20.00"], ["cash", "credit", "20.00"],
    ]),
  ];
  const reports = calculateAccountingReports(accounts, dailyBooks, "2026-02-10", "2026-02-10");

  assert.deepEqual(
    [reports.totals.incomeZmw, reports.totals.expensesZmw, reports.totals.netIncomeZmw],
    ["25.00", "4.00", "21.00"],
  );
  assert.equal(reports.incomeStatement.find((row) => row.code === "4100")?.amountZmw, "25.00");
  assert.equal(reports.incomeStatement.find((row) => row.code === "6300")?.amountZmw, "4.00");
});

test("period expense totals and fund balances reconcile to journals across payment methods", () => {
  const expenseJournals: FixtureLine[] = [
    ...journal("2026-01-31", [
      ["rent", "debit", "10.00"], ["cash", "credit", "10.00"],
    ]),
    ...journal("2026-02-01", [
      ["rent", "debit", "12.34"], ["bank", "credit", "12.34"],
    ]),
    ...journal("2026-03-15", [
      ["cogs", "debit", "7.66"], ["mobile_money", "credit", "7.66"],
    ]),
    ...journal("2026-03-31", [
      ["rent", "debit", "5.00"], ["other_funds", "credit", "5.00"],
    ]),
    ...journal("2026-04-01", [
      ["rent", "debit", "100.00"], ["cash", "credit", "100.00"],
    ]),
  ];
  const reports = calculateAccountingReports(accounts, expenseJournals, "2026-02-01", "2026-03-31");
  const trialByCode = new Map(reports.trialBalance.map((row) => [row.code, row]));

  assert.equal(reports.totals.expensesZmw, "25.00");
  assert.deepEqual(
    reports.incomeStatement
      .filter((row) => row.type === "expense")
      .map((row) => [row.code, row.amountZmw]),
    [["5100", "7.66"], ["6300", "17.34"]],
  );
  assert.deepEqual(
    ["1010", "1020", "1030", "1040"].map((code) => trialByCode.get(code)?.creditZmw),
    ["10.00", "12.34", "7.66", "5.00"],
    "fund balances include their posted credits through the report end date",
  );
  assert.equal(trialByCode.get("1010")?.debitZmw, "0.00");
  assert.equal(trialByCode.get("1020")?.debitZmw, "0.00");
  assert.equal(trialByCode.get("1030")?.debitZmw, "0.00");
  assert.equal(trialByCode.get("1040")?.debitZmw, "0.00");
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
  assert.equal(reports.balanceSheetReconciliation.isBalanced, true);
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

test("receipts and expenses on one fund report as a net balance without inflating expenses", () => {
  const overlappingActivity: FixtureLine[] = [
    ...journal("2026-11-01", [["receivables", "debit", "300.00"], ["sales", "credit", "300.00"]]),
    ...journal("2026-11-02", [["bank", "debit", "300.00"], ["receivables", "credit", "300.00"]]),
    ...journal("2026-11-03", [["rent", "debit", "100.00"], ["bank", "credit", "100.00"]]),
  ];
  const reports = calculateAccountingReports(accounts, overlappingActivity, "2026-11-01", "2026-11-30");

  assert.equal(reports.trialBalance.find((row) => row.code === "1020")?.balanceZmw, "200.00");
  assert.equal(reports.totals.incomeZmw, "300.00");
  assert.equal(reports.totals.expensesZmw, "100.00");
  assert.equal(reports.incomeStatement.find((row) => row.code === "6300")?.amountZmw, "100.00");
  assert.equal(reports.totals.trialDebitsZmw, reports.totals.trialCreditsZmw);
  assert.equal(reports.balanceSheetReconciliation.isBalanced, true);
});

test("year-end reports exclude income and expenses dated after the selected cutoff", () => {
  const entriesAfterCutoff: FixtureLine[] = [
    ...journal("2025-12-31", [["cash", "debit", "1000.00"], ["equity", "credit", "1000.00"]]),
    ...journal("2026-03-31", [["cash", "debit", "200.00"], ["sales", "credit", "200.00"]]),
    ...journal("2026-12-31", [["cash", "debit", "500.00"], ["sales", "credit", "500.00"]]),
    ...journal("2027-01-01", [["rent", "debit", "50.00"], ["cash", "credit", "50.00"]]),
  ];
  const reports = calculateAccountingReports(accounts, entriesAfterCutoff, "2026-01-01", "2026-06-30");

  assert.equal(reports.totals.incomeZmw, "200.00");
  assert.equal(reports.totals.expensesZmw, "0.00");
  assert.equal(reports.balanceSheet.at(-1)?.amountZmw, "200.00");
  assert.equal(reports.trialBalance.find((row) => row.code === "1010")?.balanceZmw, "1200.00");
  assert.equal(reports.totals.trialDebitsZmw, reports.totals.trialCreditsZmw);
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

  assert.deepEqual(exports.trialBalance.slice(5), reports.trialBalance.map((row) => [
    row.code, row.name, row.type, row.debitZmw, row.creditZmw, row.balanceZmw,
  ]));
  assert.deepEqual(exports.incomeStatement.slice(5), reports.incomeStatement.map((row) => [
    row.code, row.name, row.type, row.amountZmw,
  ]));
  assert.deepEqual(exports.balanceSheet.slice(5), reports.balanceSheet.map((row) => [
    row.code, row.name, row.type, row.amountZmw,
  ]));
  for (const rows of Object.values(exports)) {
    assert.deepEqual(rows.slice(0, 3), [
      ["Report period", "2026-02-01 through 2026-03-31"],
      ["From", "2026-02-01"],
      ["Through", "2026-03-31"],
    ]);
  }
});

test("unbalanced balance sheets report and export the difference without changing journal lines", () => {
  const originalLines: AccountingReportLine[] = [
    {
      accountId: 1, entryDate: "2026-01-01", debitZmw: "100.00", creditZmw: "0.00",
      entryId: 12, entryNumber: "JE-2026-00012",
    },
    // The balanced journal's other account is missing from the report's account list.
    {
      accountId: 999, entryDate: "2026-01-01", debitZmw: "0.00", creditZmw: "100.00",
      entryId: 12, entryNumber: "JE-2026-00012",
    },
  ];
  const linesBeforeReport = structuredClone(originalLines);
  assert.equal(
    originalLines.reduce((sum, line) => sum + Number(line.debitZmw), 0),
    originalLines.reduce((sum, line) => sum + Number(line.creditZmw), 0),
    "source journal lines remain balanced",
  );

  const reports = calculateAccountingReports(accounts, originalLines, "2026-01-01", "2026-12-31");

  assert.deepEqual(reports.balanceSheetReconciliation, {
    assetsZmw: "100.00",
    liabilitiesAndEquityZmw: "0.00",
    differenceZmw: "100.00",
    isBalanced: false,
  });
  assert.deepEqual(reports.trialBalanceReconciliation, {
    debitsZmw: "100.00",
    creditsZmw: "0.00",
    differenceZmw: "100.00",
    isBalanced: false,
  });
  assert.deepEqual(reports.balanceSheetDiagnostics, [{
    entryId: 12,
    entryNumber: "JE-2026-00012",
    entryDate: "2026-01-01",
    differenceZmw: "100.00",
    hasUnknownAccount: true,
  }]);
  assert.deepEqual(originalLines, linesBeforeReport, "reporting must not modify journal lines");
  assert.deepEqual(accountingReportExportRows(reports).trialBalance.at(-1), [
    "", "WARNING: Trial balance does not balance", "Difference ZMW", "", "", "100.00",
  ]);
  const exportRows = accountingReportExportRows(reports).balanceSheet;
  assert.deepEqual(exportRows.slice(-3), [
    ["", "Total assets", "Reconciliation", "100.00"],
    ["", "Liabilities and equity", "Reconciliation", "0.00"],
    ["", "WARNING: Balance sheet does not balance", "Difference ZMW", "100.00"],
  ]);
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
  const exportedBalances = new Map(exports.balanceSheet.slice(5).map(([code, , , amount]) => [code, amount]));
  assert.deepEqual(
    ["1010", "1020", "1030"].map((code) => exportedBalances.get(code)),
    ["30.00", "50.00", "20.00"],
  );
  assert.equal(exportedBalances.get("1000"), "250.00");
});

test("accounting reports reject malformed and reversed date ranges", () => {
  assert.throws(
    () => calculateAccountingReports(accounts, knownBooks, "2026-02-30", "2026-03-31"),
    /valid start and end date/,
  );
  assert.throws(
    () => calculateAccountingReports(accounts, knownBooks, "2026-04-01", "2026-03-31"),
    /valid start and end date/,
  );
});

test("income and expense reversals update lifetime earnings without changing prior periods", () => {
  const reversalBooks: FixtureLine[] = [
    ...journal("2026-01-10", [["cash", "debit", "200.00"], ["sales", "credit", "200.00"]]),
    ...journal("2026-01-12", [["rent", "debit", "50.00"], ["cash", "credit", "50.00"]]),
    ...journal("2026-02-02", [["sales", "debit", "200.00"], ["cash", "credit", "200.00"]]),
    ...journal("2026-02-03", [["cash", "debit", "50.00"], ["rent", "credit", "50.00"]]),
  ];

  const january = calculateAccountingReports(accounts, reversalBooks, "2026-01-01", "2026-01-31");
  assert.equal(january.balanceSheet.at(-1)?.amountZmw, "150.00");
  assert.deepEqual(
    [january.totals.incomeZmw, january.totals.expensesZmw, january.totals.netIncomeZmw],
    ["200.00", "50.00", "150.00"],
  );

  const february = calculateAccountingReports(accounts, reversalBooks, "2026-02-01", "2026-02-28");
  assert.equal(february.balanceSheet.at(-1)?.amountZmw, "0.00");
  assert.deepEqual(
    [february.totals.incomeZmw, february.totals.expensesZmw, february.totals.netIncomeZmw],
    ["-200.00", "-50.00", "-150.00"],
  );
  assert.equal(february.balanceSheetReconciliation.isBalanced, true);
});

test("saved expenses are flagged when their active journals are missing or inconsistent", () => {
  const expenses = [
    {
      expenseId: 1, effectiveDate: "2026-02-01", amountZmw: "20.00",
      expenseAccountKey: "expense_rent", cashAccountKey: "cash_on_hand", journalEntryId: 10,
    },
    {
      expenseId: 2, effectiveDate: "2026-02-02", amountZmw: "12.50",
      expenseAccountKey: "expense_utilities", cashAccountKey: "bank", journalEntryId: null,
    },
  ];
  const warnings = findExpenseJournalWarnings(expenses, [{
    entryId: 10,
    entryDate: "2026-02-01",
    lines: [
      { accountKey: "expense_rent", debitZmw: "20.00", creditZmw: "0.00" },
      { accountKey: "bank", debitZmw: "0.00", creditZmw: "20.00" },
    ],
  }]);
  assert.deepEqual(warnings, [
    {
      expenseId: 1,
      journalEntryId: 10,
      reason: "The active journal date, amount, or accounts do not match the saved expense.",
    },
    {
      expenseId: 2,
      journalEntryId: null,
      reason: "No active journal entry is linked.",
    },
  ]);
});

test("accounting report route returns clear 400s for invalid date filters", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ pool }, { registerAccountingRoutes }] = await Promise.all([
    import("./db"),
    import("./accounting-routes"),
  ]);
  const app = express();
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: "accounting-date-test", email: "accounting-date-test@example.test", role: "owner" };
    next();
  };
  registerAccountingRoutes(app, owner);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    for (const query of [
      "?from=&to=2026-01-31",
      "?from=2026-01-01&from=2026-01-02&to=2026-01-31",
      "?from=not-a-date&to=2026-01-31",
      "?from=2026-02-30&to=2026-03-01",
      "?from=2026-02-01&to=2026-01-31",
    ]) {
      const response = await fetch(`${baseUrl}/api/accounting${query}`);
      const payload = await response.json() as { error?: string };
      assert.equal(response.status, 400, `${query}: ${JSON.stringify(payload)}`);
      assert.ok(payload.error, `${query} should return a helpful date error`);
    }

    const validResponse = await fetch(`${baseUrl}/api/accounting?from=2026-01-01&to=2026-01-31`);
    const validPayload = await validResponse.json() as { period?: { from: string; to: string } };
    assert.equal(validResponse.status, 200, JSON.stringify(validPayload));
    assert.deepEqual(validPayload.period, { from: "2026-01-01", to: "2026-01-31" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  }
});
