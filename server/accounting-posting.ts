import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { accountingAccounts, journalEntries, journalLines } from "../shared/schema";

export const accounts = [
  { code: "1000", name: "Cash and bank (previously combined)", type: "asset" as const, systemKey: "cash_bank" },
  { code: "1010", name: "Cash on hand", type: "asset" as const, systemKey: "cash_on_hand" },
  { code: "1020", name: "Bank account", type: "asset" as const, systemKey: "bank_account" },
  { code: "1030", name: "Mobile money", type: "asset" as const, systemKey: "mobile_money" },
  { code: "1040", name: "Other funds", type: "asset" as const, systemKey: "other_funds" },
  { code: "1100", name: "Inventory", type: "asset" as const, systemKey: "inventory" },
  { code: "1150", name: "Landed cost clearing", type: "asset" as const, systemKey: "landed_cost_clearing" },
  { code: "1200", name: "Accounts receivable", type: "asset" as const, systemKey: "accounts_receivable" },
  { code: "2100", name: "Accounts payable", type: "liability" as const, systemKey: "accounts_payable" },
  { code: "2200", name: "Business loans payable", type: "liability" as const, systemKey: "business_loans_payable" },
  { code: "3000", name: "Owner equity", type: "equity" as const, systemKey: "owner_equity" },
  { code: "3100", name: "Opening balance equity", type: "equity" as const, systemKey: "opening_balance_equity" },
  { code: "4100", name: "Sales revenue", type: "income" as const, systemKey: "sales_revenue" },
  { code: "5100", name: "Cost of goods sold", type: "expense" as const, systemKey: "cost_of_goods_sold" },
  { code: "6100", name: "Inventory adjustments", type: "expense" as const, systemKey: "inventory_adjustments" },
  { code: "6200", name: "Marketing expenses", type: "expense" as const, systemKey: "marketing_expense" },
];

export type PostingLine = {
  accountKey: string;
  debitZmw?: string;
  creditZmw?: string;
  productId?: number | null;
  description?: string | null;
};

export function cents(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

export function formatCents(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

export function journalLinesAreBalanced(lines: PostingLine[]) {
  const debit = lines.reduce((sum, line) => sum + cents(line.debitZmw ?? "0.00"), 0n);
  const credit = lines.reduce((sum, line) => sum + cents(line.creditZmw ?? "0.00"), 0n);
  return debit > 0n && debit === credit;
}

export function cashAccountKeyForMethod(method: "cash" | "bank_transfer" | "mobile_money" | "other") {
  switch (method) {
    case "cash": return "cash_on_hand";
    case "bank_transfer": return "bank_account";
    case "mobile_money": return "mobile_money";
    case "other": return "other_funds";
  }
}

export function buildOpeningBalanceLines(input: {
  cashOnHandZmw: string;
  bankZmw: string;
  mobileMoneyZmw: string;
  otherFundsZmw: string;
  receivablesZmw: string;
  payablesZmw: string;
  loansPayableZmw: string;
  ownerEquityZmw: string;
}): PostingLine[] {
  const lines: PostingLine[] = [];
  const debits = [
    ["cash_on_hand", input.cashOnHandZmw, "Opening cash on hand"],
    ["bank_account", input.bankZmw, "Opening bank balance"],
    ["mobile_money", input.mobileMoneyZmw, "Opening mobile money balance"],
    ["other_funds", input.otherFundsZmw, "Other opening funds"],
    ["accounts_receivable", input.receivablesZmw, "Opening customer balances owed"],
  ] as const;
  const credits = [
    ["accounts_payable", input.payablesZmw, "Opening supplier balances owed"],
    ["business_loans_payable", input.loansPayableZmw, "Opening business loans"],
    ["owner_equity", input.ownerEquityZmw, "Opening owner funds"],
  ] as const;
  let debitTotal = 0n;
  let creditTotal = 0n;

  for (const [accountKey, amount, description] of debits) {
    const value = cents(amount);
    if (value > 0n) {
      debitTotal += value;
      lines.push({ accountKey, debitZmw: formatCents(value), description });
    }
  }
  for (const [accountKey, amount, description] of credits) {
    const value = cents(amount);
    if (value > 0n) {
      creditTotal += value;
      lines.push({ accountKey, creditZmw: formatCents(value), description });
    }
  }

  const difference = debitTotal - creditTotal;
  if (difference > 0n) {
    lines.push({
      accountKey: "opening_balance_equity",
      creditZmw: formatCents(difference),
      description: "Temporary balancing amount; review after opening stock is recorded",
    });
  } else if (difference < 0n) {
    lines.push({
      accountKey: "opening_balance_equity",
      debitZmw: formatCents(-difference),
      description: "Temporary balancing amount; review after opening stock is recorded",
    });
  }
  return lines;
}

export async function ensureAccountingAccounts(tx: any) {
  await tx.insert(accountingAccounts).values(accounts).onConflictDoNothing();
  const rows = await tx.select().from(accountingAccounts);
  return new Map<string, typeof accountingAccounts.$inferSelect>(
    rows.filter((row: typeof accountingAccounts.$inferSelect) => row.systemKey !== null)
      .map((row: typeof accountingAccounts.$inferSelect) => [row.systemKey!, row]),
  );
}

export async function postJournal(tx: any, input: {
  sourceKey: string; sourceType: string; sourceId: number; memo: string; entryDate?: string; lines: PostingLine[];
}) {
  const [existing] = await tx.select().from(journalEntries).where(eq(journalEntries.sourceKey, input.sourceKey)).limit(1);
  if (existing) return existing;
  if (!journalLinesAreBalanced(input.lines)) throw new Error("Journal entry must have equal, positive debits and credits.");
  const accountMap = await ensureAccountingAccounts(tx);
  const inserted = await tx.insert(journalEntries).values({
    entryNumber: `JE-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    sourceKey: input.sourceKey, sourceType: input.sourceType, sourceId: input.sourceId,
    memo: input.memo, entryDate: input.entryDate ?? new Date().toISOString().slice(0, 10),
  }).returning();
  const entry = inserted[0] as typeof journalEntries.$inferSelect;
  await tx.insert(journalLines).values(input.lines.map((line) => {
    const account = accountMap.get(line.accountKey);
    if (!account) throw new Error(`Accounting account ${line.accountKey} is missing.`);
    return {
      journalEntryId: entry.id, accountId: account.id, productId: line.productId ?? null,
      description: line.description ?? null, debitZmw: line.debitZmw ?? "0.00", creditZmw: line.creditZmw ?? "0.00",
    };
  }));
  return entry;
}

export async function accountBalance(tx: any, accountKey: string, productId?: number) {
  const accountMap = await ensureAccountingAccounts(tx);
  const account = accountMap.get(accountKey);
  if (!account) return 0n;
  const result = await tx.execute(sql`
    select coalesce(sum(${journalLines.debitZmw}::numeric - ${journalLines.creditZmw}::numeric), 0)::text as balance
    from ${journalLines}
    where ${journalLines.accountId} = ${account.id}
    ${productId === undefined ? sql`` : sql`and ${journalLines.productId} = ${productId}`}
  `);
  const value = result.rows?.[0]?.balance ?? "0";
  const [whole, fraction = ""] = String(value).split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}
