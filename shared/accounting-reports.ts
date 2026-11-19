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
  trialBalance: TrialBalanceRow[];
  incomeStatement: AccountingReportRow[];
  balanceSheet: AccountingReportRow[];
  balanceSheetReconciliation: BalanceSheetReconciliation;
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

export function calculateAccountingReports(
  accounts: AccountingReportAccount[],
  lines: AccountingReportLine[],
  from: string,
  to: string,
): AccountingReports {
  const throughEnd = lines.filter((line) => line.entryDate <= to);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const accountBalance = new Map<number, bigint>();
  const periodBalance = new Map<number, bigint>();

  for (const line of throughEnd) {
    const net = cents(line.debitZmw) - cents(line.creditZmw);
    accountBalance.set(line.accountId, (accountBalance.get(line.accountId) ?? 0n) + net);

    if (line.entryDate >= from) {
      const account = accountById.get(line.accountId);
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

  return {
    trialBalance,
    incomeStatement,
    balanceSheet,
    balanceSheetReconciliation: {
      assetsZmw: money(assetsCents),
      liabilitiesAndEquityZmw: money(liabilitiesAndEquityCents),
      differenceZmw: money(balanceSheetDifference),
      isBalanced: balanceSheetDifference === 0n,
    },
    totals: {
      trialDebitsZmw: money(trialBalance.reduce((sum, row) => sum + cents(row.debitZmw), 0n)),
      trialCreditsZmw: money(trialBalance.reduce((sum, row) => sum + cents(row.creditZmw), 0n)),
      incomeZmw: money(incomeCents),
      expensesZmw: money(expenseCents),
      netIncomeZmw: money(incomeCents - expenseCents),
    },
  };
}

export function accountingReportExportRows<
  TTrial extends { code: string; name: string; type: string; debitZmw: string; creditZmw: string; balanceZmw: string },
  TReport extends { code: string; name: string; type: string; amountZmw: string },
>(
  reports: {
    trialBalance: TTrial[];
    incomeStatement: TReport[];
    balanceSheet: TReport[];
    balanceSheetReconciliation?: BalanceSheetReconciliation;
  },
) {
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
    trialBalance: [
      ["Code", "Account", "Type", "Debit ZMW", "Credit ZMW", "Balance ZMW"],
      ...reports.trialBalance.map((row) => [
        row.code, row.name, row.type, row.debitZmw, row.creditZmw, row.balanceZmw,
      ]),
    ],
    incomeStatement: [
      ["Code", "Account", "Type", "Amount ZMW"],
      ...reports.incomeStatement.map((row) => [row.code, row.name, row.type, row.amountZmw]),
    ],
    balanceSheet: balanceSheetRows,
  };
}
