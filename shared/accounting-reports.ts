type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export type AccountingReportAccount = {
  id: number;
  code: string;
  name: string;
  type: AccountType;
};

export type AccountingReportLine = {
  accountId: number;
  entryDate: string;
  debitZmw: string;
  creditZmw: string;
  entryId?: number;
  entryNumber?: string;
};

export type TrialBalanceReconciliation = {
  debitsZmw: string;
  creditsZmw: string;
  differenceZmw: string;
  isBalanced: boolean;
};

export type BalanceSheetDiagnostic = {
  entryId: number;
  entryNumber: string;
  entryDate: string;
  differenceZmw: string;
  hasUnknownAccount: boolean;
};

export type ExpenseJournalWarning = {
  expenseId: number;
  journalEntryId: number | null;
  reason: string;
};

export type AccountingReportRow = {
  code: string;
  name: string;
  type: AccountType;
  amountZmw: string;
};

export type TrialBalanceRow = Omit<AccountingReportRow, "amountZmw"> & {
  accountId: number;
  debitZmw: string;
  creditZmw: string;
  balanceZmw: string;
};

export type BalanceSheetReconciliation = {
  assetsZmw: string;
  liabilitiesAndEquityZmw: string;
  differenceZmw: string;
  isBalanced: boolean;
};

export type AccountingReports = {
  period: { from: string; to: string };
  trialBalance: TrialBalanceRow[];
  incomeStatement: AccountingReportRow[];
  balanceSheet: AccountingReportRow[];
  balanceSheetReconciliation: BalanceSheetReconciliation;
  trialBalanceReconciliation: TrialBalanceReconciliation;
  balanceSheetDiagnostics: BalanceSheetDiagnostic[];
  totals: {
    trialDebitsZmw: string;
    trialCreditsZmw: string;
    incomeZmw: string;
    expensesZmw: string;
    netIncomeZmw: string;
  };
};

function cents(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  return negative ? -amount : amount;
}

function money(value: bigint): string {
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

function isValidDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function calculateAccountingReports(
  accounts: AccountingReportAccount[],
  lines: AccountingReportLine[],
  from: string,
  to: string,
): AccountingReports {
  if (!isValidDate(from) || !isValidDate(to) || from > to) {
    throw new Error("Choose a valid start and end date.");
  }
  const throughEnd = lines.filter((line) => line.entryDate <= to);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const accountBalance = new Map<number, bigint>();
  const periodBalance = new Map<number, bigint>();
  const diagnosticEntries = new Map<number, {
    entryNumber: string;
    entryDate: string;
    difference: bigint;
    hasUnknownAccount: boolean;
  }>();

  for (const line of throughEnd) {
    const net = cents(line.debitZmw) - cents(line.creditZmw);
    const account = accountById.get(line.accountId);
    if (account) accountBalance.set(line.accountId, (accountBalance.get(line.accountId) ?? 0n) + net);

    if (line.entryId !== undefined && line.entryNumber !== undefined) {
      const diagnostic = diagnosticEntries.get(line.entryId) ?? {
        entryNumber: line.entryNumber,
        entryDate: line.entryDate,
        difference: 0n,
        hasUnknownAccount: false,
      };
      if (!account) {
        diagnostic.hasUnknownAccount = true;
      } else {
        diagnostic.difference += net;
      }
      diagnosticEntries.set(line.entryId, diagnostic);
    }

    if (line.entryDate >= from) {
      if (account && (account.type === "income" || account.type === "expense")) {
        periodBalance.set(line.accountId, (periodBalance.get(line.accountId) ?? 0n) + net);
      }
    }
  }

  const trialBalance = accounts.map((account) => {
    const raw = accountBalance.get(account.id) ?? 0n;
    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      debitZmw: money(raw > 0n ? raw : 0n),
      creditZmw: money(raw < 0n ? -raw : 0n),
      balanceZmw: money(
        account.type === "liability" || account.type === "equity" || account.type === "income"
          ? -raw
          : raw,
      ),
    };
  });

  const incomeStatement = accounts
    .filter((account) => account.type === "income" || account.type === "expense")
    .map((account) => {
      const raw = periodBalance.get(account.id) ?? 0n;
      return {
        code: account.code,
        name: account.name,
        type: account.type,
        amountZmw: money(account.type === "income" ? -raw : raw),
      };
    });
  const incomeCents = incomeStatement
    .filter((row) => row.type === "income")
    .reduce((sum, row) => sum + cents(row.amountZmw), 0n);
  const expenseCents = incomeStatement
    .filter((row) => row.type === "expense")
    .reduce((sum, row) => sum + cents(row.amountZmw), 0n);
  const balanceSheet = accounts
    .filter((account) => account.type === "asset" || account.type === "liability" || account.type === "equity")
    .map((account) => ({
      code: account.code,
      name: account.name,
      type: account.type,
      amountZmw: money(
        (accountBalance.get(account.id) ?? 0n) *
          (account.type === "liability" || account.type === "equity" ? -1n : 1n),
      ),
    }));

  const lifetimeProfit = throughEnd.reduce((sum, line) => {
    const account = accountById.get(line.accountId);
    if (account?.type === "income") return sum + cents(line.creditZmw) - cents(line.debitZmw);
    if (account?.type === "expense") return sum - cents(line.debitZmw) + cents(line.creditZmw);
    return sum;
  }, 0n);
  balanceSheet.push({
    code: "",
    name: "Accumulated earnings (not closed)",
    type: "equity",
    amountZmw: money(lifetimeProfit),
  });

  const assetsCents = balanceSheet
    .filter((row) => row.type === "asset")
    .reduce((sum, row) => sum + cents(row.amountZmw), 0n);
  const liabilitiesAndEquityCents = balanceSheet
    .filter((row) => row.type === "liability" || row.type === "equity")
    .reduce((sum, row) => sum + cents(row.amountZmw), 0n);
  const balanceSheetDifference = assetsCents - liabilitiesAndEquityCents;
  const trialDebits = trialBalance.reduce((sum, row) => sum + cents(row.debitZmw), 0n);
  const trialCredits = trialBalance.reduce((sum, row) => sum + cents(row.creditZmw), 0n);
  const trialDifference = trialDebits - trialCredits;

  return {
    period: { from, to },
    trialBalance,
    incomeStatement,
    balanceSheet,
    balanceSheetReconciliation: {
      assetsZmw: money(assetsCents),
      liabilitiesAndEquityZmw: money(liabilitiesAndEquityCents),
      differenceZmw: money(balanceSheetDifference),
      isBalanced: balanceSheetDifference === 0n,
    },
    trialBalanceReconciliation: {
      debitsZmw: money(trialDebits),
      creditsZmw: money(trialCredits),
      differenceZmw: money(trialDifference),
      isBalanced: trialDifference === 0n,
    },
    balanceSheetDiagnostics: [...diagnosticEntries.entries()]
      .filter(([, entry]) => entry.difference !== 0n || entry.hasUnknownAccount)
      .map(([entryId, entry]) => ({
        entryId,
        entryNumber: entry.entryNumber,
        entryDate: entry.entryDate,
        differenceZmw: money(entry.difference),
        hasUnknownAccount: entry.hasUnknownAccount,
      })),
    totals: {
      trialDebitsZmw: money(trialDebits),
      trialCreditsZmw: money(trialCredits),
      incomeZmw: money(incomeCents),
      expensesZmw: money(expenseCents),
      netIncomeZmw: money(incomeCents - expenseCents),
    },
  };
}

export function findExpenseJournalWarnings(
  expenses: Array<{
    expenseId: number;
    effectiveDate: string;
    amountZmw: string;
    expenseAccountKey: string;
    cashAccountKey: string;
    journalEntryId: number | null;
  }>,
  journals: Array<{
    entryId: number;
    entryDate: string;
    lines: Array<{
      accountKey: string | null;
      debitZmw: string;
      creditZmw: string;
    }>;
  }>,
): ExpenseJournalWarning[] {
  const journalsById = new Map(journals.map((journal) => [journal.entryId, journal]));
  return expenses.flatMap((expense) => {
    const journal = expense.journalEntryId === null ? undefined : journalsById.get(expense.journalEntryId);
    if (!journal) {
      return [{ expenseId: expense.expenseId, journalEntryId: expense.journalEntryId, reason: "No active journal entry is linked." }];
    }
    const expected = cents(expense.amountZmw);
    const debitTotal = journal.lines.reduce((sum, line) => sum + cents(line.debitZmw), 0n);
    const creditTotal = journal.lines.reduce((sum, line) => sum + cents(line.creditZmw), 0n);
    const expenseDebit = journal.lines
      .filter((line) => line.accountKey === expense.expenseAccountKey)
      .reduce((sum, line) => sum + cents(line.debitZmw), 0n);
    const cashCredit = journal.lines
      .filter((line) => line.accountKey === expense.cashAccountKey)
      .reduce((sum, line) => sum + cents(line.creditZmw), 0n);
    const onlyExpectedAccounts = journal.lines.length === 2
      && journal.lines.every((line) => line.accountKey === expense.expenseAccountKey || line.accountKey === expense.cashAccountKey);
    const matches = journal.entryDate === expense.effectiveDate
      && debitTotal === expected
      && creditTotal === expected
      && expenseDebit === expected
      && cashCredit === expected
      && onlyExpectedAccounts;
    return matches
      ? []
      : [{
        expenseId: expense.expenseId,
        journalEntryId: journal.entryId,
        reason: "The active journal date, amount, or accounts do not match the saved expense.",
      }];
  });
}

export function accountingReportExportRows<
  TTrial extends { code: string; name: string; type: string; debitZmw: string; creditZmw: string; balanceZmw: string },
  TReport extends { code: string; name: string; type: string; amountZmw: string },
>(
  reports: {
    period: { from: string; to: string };
    trialBalance: TTrial[];
    incomeStatement: TReport[];
    balanceSheet: TReport[];
    balanceSheetReconciliation?: BalanceSheetReconciliation;
    trialBalanceReconciliation: TrialBalanceReconciliation;
  },
) {
  const periodRows = [
    ["Report period", `${reports.period.from} through ${reports.period.to}`],
    ["From", reports.period.from],
    ["Through", reports.period.to],
    [],
  ];
  const trialBalanceRows = [
    ["Code", "Account", "Type", "Debit ZMW", "Credit ZMW", "Balance ZMW"],
    ...reports.trialBalance.map((row) => [
      row.code, row.name, row.type, row.debitZmw, row.creditZmw, row.balanceZmw,
    ]),
  ];
  if (!reports.trialBalanceReconciliation.isBalanced) {
    trialBalanceRows.push([
      "", "WARNING: Trial balance does not balance", "Difference ZMW", "", "",
      reports.trialBalanceReconciliation.differenceZmw,
    ]);
  }
  const balanceSheetRows = [
    ["Code", "Account", "Type", "Amount ZMW"],
    ...reports.balanceSheet.map((row) => [row.code, row.name, row.type, row.amountZmw]),
  ];
  const reconciliation = reports.balanceSheetReconciliation;
  if (reconciliation && !reconciliation.isBalanced) {
    const differenceCents = cents(reconciliation.differenceZmw);
    balanceSheetRows.push(
      ["", "Total assets", "Reconciliation", reconciliation.assetsZmw],
      ["", "Liabilities and equity", "Reconciliation", reconciliation.liabilitiesAndEquityZmw],
      ["", "WARNING: Balance sheet does not balance", "Difference ZMW", money(differenceCents < 0n ? -differenceCents : differenceCents)],
    );
  }

  return {
    trialBalance: [...periodRows, ...trialBalanceRows],
    incomeStatement: [
      ...periodRows,
      ["Code", "Account", "Type", "Amount ZMW"],
      ...reports.incomeStatement.map((row) => [row.code, row.name, row.type, row.amountZmw]),
    ],
    balanceSheet: [...periodRows, ...balanceSheetRows],
  };
}
