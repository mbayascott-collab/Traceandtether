import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { accountingReportExportRows } from "../../shared/accounting-reports";
import { fetchAccountingJournalEntry, type AccountingJournalEntry } from "../lib/api";

type ReportRow = { code: string; name: string; type: string; amountZmw: string };
type TrialRow = ReportRow & { accountId: number; debitZmw: string; creditZmw: string; balanceZmw: string };
type BalanceSheetReconciliation = {
  assetsZmw: string;
  liabilitiesAndEquityZmw: string;
  differenceZmw: string;
  isBalanced: boolean;
};
type JournalEntry = AccountingJournalEntry;
type ExpenseEntry = {
  id: number; category: string; description: string; amountZmw: string; expenseDate: string;
  method: string; reference: string | null; notes: string | null;
  effective: {
    category: string; description: string; amountZmw: string; expenseDate: string;
    method: string; reference: string | null; notes: string | null;
  };
  correctionCount: number;
};
type OwnerFundTransaction = {
  id: number; kind: string; amountZmw: string; transactionDate: string;
  method: string; reference: string | null; notes: string | null; accountName: string;
  effective: {
    kind: string; amountZmw: string; transactionDate: string; method: string;
    reference: string | null; notes: string | null; accountName: string;
  };
  correctionCount: number;
};
type ReportData = {
  period: { from: string; to: string };
  entries: JournalEntry[];
  expenses?: ExpenseEntry[];
  expenseJournalWarnings: { expenseId: number; journalEntryId: number | null; reason: string }[];
  ownerTransactions?: OwnerFundTransaction[];
  canCorrectRecords: boolean;
  correctionHistory?: Array<{
    id: number; recordType: string; recordId: number; previousCorrectionId: number | null;
    effectiveDate: string; amountZmw: string; reason: string; reversalEntryId: number | null;
    reversalEntryNumber: string | null; replacementEntryId: number | null; replacementEntryNumber: string | null;
  }>;
  openingBalances: {
    posted: boolean;
    entryDate: string | null;
    activeEntryId: number | null;
    replacementReversalId: number | null;
    canCorrect: boolean;
    history: Array<{
      id: number; entryDate: string; entryNumber: string; memo: string;
      kind: "opening_balance" | "replacement" | "reversal";
      relatedEntryId: number | null; reversalEntryId: number | null; reversed: boolean;
    }>;
  };
  trialBalance: TrialRow[];
  incomeStatement: ReportRow[];
  balanceSheet: ReportRow[];
  balanceSheetReconciliation: BalanceSheetReconciliation;
  trialBalanceReconciliation: {
    debitsZmw: string;
    creditsZmw: string;
    differenceZmw: string;
    isBalanced: boolean;
  };
  balanceSheetDiagnostics: {
    entryId: number;
    entryNumber: string;
    entryDate: string;
    differenceZmw: string;
    hasUnknownAccount: boolean;
  }[];
  totals: { trialDebitsZmw: string; trialCreditsZmw: string; incomeZmw: string; expensesZmw: string; netIncomeZmw: string };
};

export function safeAccountingCorrectionHistory(
  history: ReportData["correctionHistory"] | null | undefined,
) {
  return history ?? [];
}

type AccountingListRowsProps<T> = {
  rows?: T[];
  colSpan: number;
  emptyMessage: string;
  renderRow: (row: T) => ReactNode;
};

export function AccountingListRows<T>({ rows, colSpan, emptyMessage, renderRow }: AccountingListRowsProps<T>) {
  const records = rows ?? [];
  return <>
    {records.map(renderRow)}
    {!records.length && <tr><td colSpan={colSpan}>{emptyMessage}</td></tr>}
  </>;
}

const currentYear = new Date().getFullYear();
const money = (value: string) => `ZMW ${Number(value).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function csvCell(value: unknown) {
  const text = String(value ?? "");
  const safe = /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
function downloadCsv(name: string, rows: unknown[][]) {
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

const PENDING_CORRECTION_KEY = "accounting.pending-correction.v1";
type PendingCorrectionAttempt = { fingerprint: string; key: string };

function readPendingCorrectionAttempt(): PendingCorrectionAttempt | null {
  try {
    const stored = sessionStorage.getItem(PENDING_CORRECTION_KEY);
    if (!stored) return null;
    const value = JSON.parse(stored) as Partial<PendingCorrectionAttempt>;
    if (typeof value.fingerprint === "string" && /^[0-9a-f-]{36}$/i.test(value.key ?? "")) {
      return { fingerprint: value.fingerprint, key: value.key! };
    }
    sessionStorage.removeItem(PENDING_CORRECTION_KEY);
  } catch {
    // Storage is optional; this tab can still retry using its in-memory key.
  }
  return null;
}

async function fingerprintCorrection(path: string, values: Record<string, FormDataEntryValue>) {
  const source = JSON.stringify([path, values]);
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default function AccountingWorkspace() {
  const [from, setFrom] = useState(`${currentYear}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [range, setRange] = useState({
    from: `${currentYear}-01-01`, to: new Date().toISOString().slice(0, 10),
    purchaseOrder: "", shipment: "",
  });
  const [purchaseOrderFilter, setPurchaseOrderFilter] = useState("");
  const [shipmentFilter, setShipmentFilter] = useState("");
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedJournalId] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get("journalEntryId");
    const id = raw ? Number(raw) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  });
  const [selectedJournal, setSelectedJournal] = useState<JournalEntry | null>(null);
  const [journalLoading, setJournalLoading] = useState(false);
  const [journalError, setJournalError] = useState("");
  const [editingCorrection, setEditingCorrection] = useState<{ type: "expense" | "fund"; id: number } | null>(null);
  const pendingOwnerFundAttempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const pendingCorrectionAttempt = useRef<PendingCorrectionAttempt | null>(readPendingCorrectionAttempt());

  useEffect(() => {
    let alive = true;
    setLoading(true); setError("");
    const query = new URLSearchParams({ from: range.from, to: range.to });
    if (range.purchaseOrder) query.set("purchaseOrder", range.purchaseOrder);
    if (range.shipment) query.set("shipment", range.shipment);
    fetch(`/api/accounting?${query.toString()}`)
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Accounting records could not be loaded.");
        if (alive) setData(result);
      })
      .catch((reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : "Accounting records could not be loaded."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [range]);

  useEffect(() => {
    if (selectedJournalId === null) return;
    let alive = true;
    setJournalLoading(true);
    setJournalError("");
    fetchAccountingJournalEntry(selectedJournalId)
      .then((entry) => { if (alive) setSelectedJournal(entry); })
      .catch((reason: unknown) => {
        if (alive) setJournalError(reason instanceof Error ? reason.message : "The journal entry could not be loaded.");
      })
      .finally(() => { if (alive) setJournalLoading(false); });
    return () => { alive = false; };
  }, [selectedJournalId]);

  async function recordCashIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    const fingerprint = JSON.stringify(values);
    if (pendingOwnerFundAttempt.current?.fingerprint !== fingerprint) {
      pendingOwnerFundAttempt.current = { fingerprint, key: window.crypto.randomUUID() };
    }
    try {
      const response = await fetch("/api/accounting/funds", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, idempotencyKey: pendingOwnerFundAttempt.current.key }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Owner transaction could not be recorded.");
      pendingOwnerFundAttempt.current = null;
      form.reset();
      setNotice("Owner transaction recorded and added to the journal.");
      setRange((current) => ({ ...current }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Owner transaction could not be recorded.");
    }
  }

  async function recordOpeningBalances(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const response = await fetch("/api/accounting/opening-balances", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Opening balances could not be recorded.");
      setNotice("Opening balances recorded and added to the journal.");
      setRange((current) => ({ ...current }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Opening balances could not be recorded.");
    }
  }

  async function reverseOpeningBalances(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    const entryId = data?.openingBalances.activeEntryId;
    if (!entryId) return;
    try {
      const response = await fetch(`/api/accounting/opening-balances/${entryId}/reverse`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Opening balances could not be reversed.");
      setNotice(result.message || "Opening balances reversed.");
      setRange((current) => ({ ...current }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Opening balances could not be reversed.");
    }
  }

  async function recordExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const response = await fetch("/api/accounting/expenses", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Expense could not be recorded.");
      form.reset();
      setNotice("Expense recorded and added to the journal.");
      setRange((current) => ({ ...current }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Expense could not be recorded.");
    }
  }

  async function correctAccountingRecord(event: FormEvent<HTMLFormElement>, path: string) {
    event.preventDefault(); setError(""); setNotice("");
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const fingerprint = await fingerprintCorrection(path, values);
      if (pendingCorrectionAttempt.current?.fingerprint !== fingerprint) {
        pendingCorrectionAttempt.current = { fingerprint, key: window.crypto.randomUUID() };
        try {
          sessionStorage.setItem(PENDING_CORRECTION_KEY, JSON.stringify(pendingCorrectionAttempt.current));
        } catch {
          // Keep the attempt usable in this tab even when browser storage is unavailable.
        }
      }
      const attempt = pendingCorrectionAttempt.current!;
      const response = await fetch(path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, idempotencyKey: attempt.key }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The correction could not be posted.");
      pendingCorrectionAttempt.current = null;
      try { sessionStorage.removeItem(PENDING_CORRECTION_KEY); } catch { /* Ignore unavailable storage. */ }
      setEditingCorrection(null);
      setNotice("Correction posted. The original record and journal remain in the history.");
      setRange((current) => ({ ...current }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The correction could not be posted.");
    }
  }

  const exportJournal = () => downloadCsv("journal-entries.csv", [
    ["Date", "Entry number", "Source", "Memo", "Account code", "Account", "Description", "Debit ZMW", "Credit ZMW"],
    ...(data?.entries.flatMap((entry) => entry.lines.map((line) => [
      entry.entryDate, entry.entryNumber, entry.sourceType, entry.memo, line.accountCode, line.accountName,
      line.description, line.debitZmw, line.creditZmw,
    ])) ?? []),
  ]);
  const exportRows = data ? accountingReportExportRows(data) : null;
  const exportTrialBalance = () => exportRows && downloadCsv("trial-balance.csv", exportRows.trialBalance);
  const exportIncome = () => exportRows && downloadCsv("income-statement.csv", exportRows.incomeStatement);
  const exportBalanceSheet = () => exportRows && downloadCsv("balance-sheet.csv", exportRows.balanceSheet);
  const expenses = data?.expenses;
  const ownerTransactions = data?.ownerTransactions;
  const correctionHistory = safeAccountingCorrectionHistory(data?.correctionHistory);
  const openingBalanceHistory = data?.openingBalances?.history ?? [];
  const expenseJournalWarnings = data?.expenseJournalWarnings ?? [];
  const openingHistoryById = new Map(openingBalanceHistory.map((entry) => [entry.id, entry]));
  const canEnterOpeningBalances = Boolean(data && !data.openingBalances.posted && (
    openingBalanceHistory.length === 0 ||
    (data.openingBalances.canCorrect && data.openingBalances.replacementReversalId !== null)
  ));

  return <>
    <section className="page-heading"><div><p className="eyebrow">Finance · ZMW</p><h1>Accounting</h1><p>Review and export the records posted from business activity.</p></div></section>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {notice && <div className="alert alert-success" role="status">{notice}</div>}
    <form className="panel form-grid" style={{ gridTemplateColumns: "1fr", padding: 16, marginBottom: 16 }} onSubmit={recordCashIn}>
      <h2>Record owner funds, withdrawal, or loan</h2>
      <label>Date<input name="receivedAt" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
      <label>Amount (ZMW)<input name="amountZmw" type="number" min="0.01" step="0.01" required /></label>
      <label>Account<select name="kind" defaultValue="owner_contribution">
        <option value="owner_contribution">Owner equity · contribution</option>
        <option value="business_loan">Business loans payable</option>
        <option value="owner_withdrawal">Owner withdrawals</option>
      </select></label>
      <label>Method<select name="method" defaultValue="cash">
        <option value="cash">Cash</option><option value="bank_transfer">Bank account</option>
        <option value="mobile_money">Mobile money</option><option value="other">Other</option>
      </select></label>
      <label>Reference<input name="reference" maxLength={120} placeholder="Receipt, transfer, or loan reference" /></label>
      <label>Notes<textarea name="notes" maxLength={500} /></label>
      <button className="button button-primary">Save transaction</button>
    </form>
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-heading"><h2>Owner funds and loans in period</h2><span>{ownerTransactions?.length ?? 0} records</span></div>
      <div className="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Account</th><th>Method</th><th>Reference</th><th>Amount</th><th /></tr></thead><tbody>
        <AccountingListRows rows={ownerTransactions} colSpan={7}
          emptyMessage="No owner funds, withdrawals, or loans recorded in this period."
          renderRow={(transaction) => <Fragment key={transaction.id}>
          <tr>
            <td>{transaction.effective.transactionDate}{transaction.correctionCount > 0 && <small><br />Originally {transaction.transactionDate}</small>}</td>
            <td>{transaction.effective.kind.replaceAll("_", " ")}</td>
            <td>{transaction.effective.accountName}</td>
            <td>{transaction.effective.method.replaceAll("_", " ")}</td>
            <td>{transaction.effective.reference || "—"}</td>
            <td>{money(transaction.effective.amountZmw)}{transaction.correctionCount > 0 && <small><br />Originally {money(transaction.amountZmw)}</small>}</td>
            <td>{data?.canCorrectRecords && <button className="button button-secondary" type="button" onClick={() =>
              setEditingCorrection(editingCorrection?.type === "fund" && editingCorrection.id === transaction.id
                ? null : { type: "fund", id: transaction.id })}>
              {editingCorrection?.type === "fund" && editingCorrection.id === transaction.id ? "Cancel" : "Correct"}
            </button>}</td>
          </tr>
          {editingCorrection?.type === "fund" && editingCorrection.id === transaction.id && (
            <tr><td colSpan={7}><form className="form-grid" style={{ gridTemplateColumns: "1fr" }} onSubmit={(event) =>
              correctAccountingRecord(event, `/api/accounting/funds/${transaction.id}/correct`)}>
              <h3>Correct owner transaction</h3>
              <p>The saved transaction and journal stay unchanged. A dated reversal and corrected entry will be added.</p>
              <label>Corrected date<input name="receivedAt" type="date" defaultValue={transaction.effective.transactionDate} required /></label>
              <label>Corrected amount (ZMW)<input name="amountZmw" type="number" min="0.01" step="0.01" defaultValue={transaction.effective.amountZmw} required /></label>
              <label>Corrected account<select name="kind" defaultValue={transaction.effective.kind} required>
                <option value="owner_contribution">Owner equity · contribution</option>
                <option value="business_loan">Business loans payable</option>
                <option value="owner_withdrawal">Owner withdrawals</option>
              </select></label>
              <label>Corrected method<select name="method" defaultValue={transaction.effective.method} required>
                <option value="cash">Cash</option><option value="bank_transfer">Bank account</option>
                <option value="mobile_money">Mobile money</option><option value="other">Other</option>
              </select></label>
              <label>Reference<input name="reference" maxLength={120} defaultValue={transaction.effective.reference ?? ""} /></label>
              <label>Notes<textarea name="notes" maxLength={500} defaultValue={transaction.effective.notes ?? ""} /></label>
              <label>Reason for correction<textarea name="reason" minLength={3} maxLength={450} required /></label>
              <button className="button button-primary">Post correction</button>
            </form></td></tr>
          )}
          </Fragment>} />
      </tbody></table></div>
    </section>
    <section className="panel" style={{ padding: 16, marginBottom: 16 }}>
      <h2>Record a business expense</h2>
      <form className="form-grid" style={{ gridTemplateColumns: "1fr" }} onSubmit={recordExpense}>
        <label>Date<input name="expenseDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
        <label>Expense account<select name="category" defaultValue="rent" required>
          <option value="rent">Rent</option>
          <option value="office_supplies">Office supplies</option>
          <option value="utilities">Utilities</option>
          <option value="transport">Transport</option>
          <option value="repairs">Repairs and maintenance</option>
          <option value="other">Other business expense</option>
        </select></label>
        <label>Description<input name="description" maxLength={240} placeholder="For example, shop rent or printer paper" required /></label>
        <label>Amount (ZMW)<input name="amountZmw" type="number" min="0.01" step="0.01" required /></label>
        <label>Paid from<select name="method" defaultValue="cash" required>
          <option value="cash">Cash</option><option value="bank_transfer">Bank account</option>
          <option value="mobile_money">Mobile money</option><option value="other">Other funds</option>
        </select></label>
        <label>Receipt or reference<input name="reference" maxLength={120} placeholder="Optional receipt number" /></label>
        <label>Notes<textarea name="notes" maxLength={1000} /></label>
        <button className="button button-primary">Save expense</button>
      </form>
    </section>
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-heading"><h2>Business expenses in period</h2><span>{expenses?.length ?? 0} records</span></div>
      {expenseJournalWarnings.length > 0 && <div className="alert alert-error" role="alert">
        <p>Some saved expenses do not match their active accounting journal. Review these records before relying on the report.</p>
        <ul>{expenseJournalWarnings.map((warning) => <li key={warning.expenseId}>
          Expense #{warning.expenseId}: {warning.reason}{" "}
          {warning.journalEntryId !== null && <a href={`/accounting?journalEntryId=${warning.journalEntryId}`}>Open journal entry</a>}
        </li>)}</ul>
      </div>}
      <div className="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Paid from</th><th>Reference</th><th>Amount</th><th /></tr></thead><tbody>
        <AccountingListRows rows={expenses} colSpan={7}
          emptyMessage="No business expenses recorded in this period."
          renderRow={(expense) => <Fragment key={expense.id}>
          <tr>
            <td>{expense.effective.expenseDate}{expense.correctionCount > 0 && <small><br />Originally {expense.expenseDate}</small>}</td>
            <td>{expense.effective.category.replaceAll("_", " ")}</td>
            <td>{expense.effective.description}</td><td>{expense.effective.method.replaceAll("_", " ")}</td>
            <td>{expense.effective.reference || "—"}</td>
            <td>{money(expense.effective.amountZmw)}{expense.correctionCount > 0 && <small><br />Originally {money(expense.amountZmw)}</small>}</td>
            <td>{data?.canCorrectRecords && <button className="button button-secondary" type="button" onClick={() =>
              setEditingCorrection(editingCorrection?.type === "expense" && editingCorrection.id === expense.id
                ? null : { type: "expense", id: expense.id })}>
              {editingCorrection?.type === "expense" && editingCorrection.id === expense.id ? "Cancel" : "Correct"}
            </button>}</td>
          </tr>
          {editingCorrection?.type === "expense" && editingCorrection.id === expense.id && (
            <tr><td colSpan={7}><form className="form-grid" style={{ gridTemplateColumns: "1fr" }} onSubmit={(event) =>
              correctAccountingRecord(event, `/api/accounting/expenses/${expense.id}/correct`)}>
              <h3>Correct business expense</h3>
              <p>The saved expense and journal stay unchanged. A dated reversal and corrected entry will be added.</p>
              <label>Corrected date<input name="expenseDate" type="date" defaultValue={expense.effective.expenseDate} required /></label>
              <label>Corrected expense account<select name="category" defaultValue={expense.effective.category} required>
                <option value="rent">Rent</option><option value="office_supplies">Office supplies</option>
                <option value="utilities">Utilities</option><option value="transport">Transport</option>
                <option value="repairs">Repairs and maintenance</option><option value="other">Other business expense</option>
              </select></label>
              <label>Description<input name="description" maxLength={240} defaultValue={expense.effective.description} required /></label>
              <label>Corrected amount (ZMW)<input name="amountZmw" type="number" min="0.01" step="0.01" defaultValue={expense.effective.amountZmw} required /></label>
              <label>Paid from<select name="method" defaultValue={expense.effective.method} required>
                <option value="cash">Cash</option><option value="bank_transfer">Bank account</option>
                <option value="mobile_money">Mobile money</option><option value="other">Other funds</option>
              </select></label>
              <label>Receipt or reference<input name="reference" maxLength={120} defaultValue={expense.effective.reference ?? ""} /></label>
              <label>Notes<textarea name="notes" maxLength={1000} defaultValue={expense.effective.notes ?? ""} /></label>
              <label>Reason for correction<textarea name="reason" minLength={3} maxLength={450} required /></label>
              <button className="button button-primary">Post correction</button>
            </form></td></tr>
          )}
          </Fragment>} />
      </tbody></table></div>
    </section>
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-heading"><h2>Expense and owner-fund correction history</h2><span>{correctionHistory.length} corrections in period</span></div>
      <div className="table-wrap"><table><thead><tr><th>Date / correction</th><th>Source record</th><th>Corrected amount</th><th>Reason</th><th>Reversal entry</th><th>Replacement entry</th></tr></thead><tbody>
        <AccountingListRows rows={correctionHistory} colSpan={6}
          emptyMessage="No expense or owner-fund corrections in this period."
          renderRow={(correction) => <tr key={correction.id}>
          <td>{correction.effectiveDate}<br /><small>Correction #{correction.id}</small></td>
          <td>{correction.recordType.replaceAll("_", " ")} #{correction.recordId}</td>
          <td>{money(correction.amountZmw)}</td>
          <td>{correction.reason}</td>
          <td>{correction.reversalEntryNumber ?? `Journal ${correction.reversalEntryId ?? "pending"}`}</td>
          <td>{correction.replacementEntryNumber ?? `Journal ${correction.replacementEntryId ?? "pending"}`}</td>
        </tr>} />
      </tbody></table></div>
    </section>
    <section className="panel" style={{ padding: 16, marginBottom: 16 }}>
      <h2>Starting balances and corrections</h2>
      {data?.openingBalances.posted && (
        <>
          <div className="notice-strip" role="status">
            Starting balances were recorded on {data.openingBalances.entryDate}. The journal entry is locked; corrections are recorded as linked entries.
          </div>
          {data.openingBalances.canCorrect && data.openingBalances.activeEntryId !== null && (
            <form className="form-grid" style={{ gridTemplateColumns: "1fr", marginTop: 16 }} onSubmit={reverseOpeningBalances}>
              <h3>Reverse these starting balances</h3>
              <p>First post a reasoned reversal. You can then enter corrected balances with a new date and memo.</p>
              <label>Reversal effective date<input name="effectiveAt" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
              <label>Reason for correction<textarea name="reason" minLength={3} maxLength={450} required /></label>
              <button className="button button-primary">Post reversal</button>
            </form>
          )}
        </>
      )}
      {!data?.openingBalances.posted && openingBalanceHistory.length > 0 && !data?.openingBalances.replacementReversalId && (
        <div className="notice-strip" role="status">
          Earlier starting balances were reversed. Only the owner can post their corrected replacement.
        </div>
      )}
      {canEnterOpeningBalances && (
        <form className="form-grid" style={{ gridTemplateColumns: "1fr" }} onSubmit={recordOpeningBalances}>
          {data?.openingBalances.replacementReversalId !== null && data?.openingBalances.replacementReversalId !== undefined
            ? <input type="hidden" name="reversalEntryId" value={data.openingBalances.replacementReversalId} />
            : null}
          {openingBalanceHistory.length > 0 && <h3>Enter corrected starting balances</h3>}
          <p className="notice-strip" style={{ gridColumn: "1 / -1", margin: 0 }}>
            Enter balances as of one date. Use 0 where there is no balance. Customer and supplier amounts are totals.
            Enter stock separately for each product using the reviewed quantity and average cost on the
            <a href="/stock-adjustments"> Stock adjustments page</a>. Corrections preserve the earlier entries and require a new effective date and memo.
          </p>
          <label>Effective date<input name="effectiveAt" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
          <label>Cash on hand (ZMW)<input name="cashOnHandZmw" type="number" min="0" step="0.01" defaultValue="0.00" required /></label>
          <label>Bank account (ZMW)<input name="bankZmw" type="number" min="0" step="0.01" defaultValue="0.00" required /></label>
          <label>Mobile money (ZMW)<input name="mobileMoneyZmw" type="number" min="0" step="0.01" defaultValue="0.00" required /></label>
          <label>Other funds (ZMW)<input name="otherFundsZmw" type="number" min="0" step="0.01" defaultValue="0.00" required /></label>
          <label>Customers owe the business (ZMW)<input name="receivablesZmw" type="number" min="0" step="0.01" defaultValue="0.00" required /></label>
          <label>Business owes suppliers (ZMW)<input name="payablesZmw" type="number" min="0" step="0.01" defaultValue="0.00" required /></label>
          <label>Business loans to repay (ZMW)<input name="loansPayableZmw" type="number" min="0" step="0.01" defaultValue="0.00" required /></label>
          <label>Owner funds already invested (ZMW)<input name="ownerEquityZmw" type="number" min="0" step="0.01" defaultValue="0.00" required /></label>
          <label style={{ gridColumn: "1 / -1" }}>Note<input name="memo" maxLength={500} defaultValue="Opening balances" required /></label>
          <button className="button button-primary">Save starting balances</button>
        </form>
      )}
      {(
        <div style={{ marginTop: 20 }}>
          <h3>Opening-balance journal history</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Date / entry</th><th>Record</th><th>Memo or reason</th><th>Linked entry</th><th>Status</th></tr></thead>
            <tbody>
              <AccountingListRows rows={openingBalanceHistory} colSpan={5}
                emptyMessage="No opening-balance correction history is available."
                renderRow={(entry) => {
                const relatedEntry = entry.relatedEntryId ? openingHistoryById.get(entry.relatedEntryId) : null;
                const reversalEntry = entry.reversalEntryId ? openingHistoryById.get(entry.reversalEntryId) : null;
                const label = entry.kind === "reversal" ? "Reversal" : entry.kind === "replacement" ? "Replacement" : "Original";
                return <tr key={entry.id}>
                  <td>{entry.entryDate}<br /><small>{entry.entryNumber}</small></td>
                  <td>{label}</td>
                  <td>{entry.memo}</td>
                  <td>{relatedEntry ? `${relatedEntry.entryNumber}` : "—"}</td>
                  <td>{entry.kind === "reversal"
                    ? `Reverses ${relatedEntry?.entryNumber ?? "opening entry"}`
                    : entry.reversed
                      ? `Reversed by ${reversalEntry?.entryNumber ?? "journal entry"}`
                      : "Active"}</td>
                </tr>;
              }} />
            </tbody>
          </table></div>
        </div>
      )}
    </section>
    <section className="panel form-grid" style={{ padding: 16, marginBottom: 16 }}>
      <h2>Year-end report period</h2>
      <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>Through<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <button className="button button-primary" onClick={() => setRange((current) => ({ ...current, from, to }))}>Run reports</button>
    </section>
    <div className="notice-strip" style={{ marginBottom: 16 }}>
      These reports include entries already recorded in the app. Compare bank and mobile money statements on the <a href="/payments">Payments page</a>; statement matching does not change journals. Opening stock, tax treatment, and accountant review still need to be completed before relying on this as a full year-end filing.
    </div>
    {selectedJournalId !== null && <section className="panel" style={{ marginBottom: 16 }} aria-labelledby="selected-journal-title">
      <div className="panel-heading">
        <div><h2 id="selected-journal-title">Receipt journal entry</h2>
          {selectedJournal && <span>{selectedJournal.entryNumber} · {selectedJournal.entryDate} · {selectedJournal.memo}</span>}
        </div>
        <a className="button button-secondary" href="/accounting">Back to accounting</a>
      </div>
      {journalLoading ? <div className="panel-body">Loading journal entry…</div>
        : journalError ? <div className="alert alert-error" role="alert">{journalError}</div>
          : selectedJournal && <div className="table-wrap"><table><thead><tr><th>Account</th><th>Line details</th><th>Debit</th><th>Credit</th></tr></thead><tbody>
            {selectedJournal.lines.map((line, index) => <tr key={`${selectedJournal.id}-${index}`}>
              <td>{line.accountCode} · {line.accountName}</td><td>{line.description || selectedJournal.memo}</td>
              <td>{line.debitZmw !== "0.00" ? money(line.debitZmw) : "—"}</td>
              <td>{line.creditZmw !== "0.00" ? money(line.creditZmw) : "—"}</td>
            </tr>)}
          </tbody></table></div>}
    </section>}
    {loading ? <div className="panel panel-body">Loading reports…</div> : data && <>
      <section className="metric-grid" style={{ marginBottom: 16 }}>
        <div className="metric-card"><span>Sales and other income</span><strong className="metric-value">{money(data.totals.incomeZmw)}</strong></div>
        <div className="metric-card"><span>Recorded expenses</span><strong className="metric-value">{money(data.totals.expensesZmw)}</strong></div>
        <div className="metric-card"><span>Net income for period</span><strong className="metric-value">{money(data.totals.netIncomeZmw)}</strong></div>
      </section>
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-heading"><h2>Year-end exports</h2><span>{range.from} to {range.to}</span></div>
        <div className="panel-body toolbar">
          <button className="button button-secondary" onClick={exportJournal}>Download journal</button>
          <button className="button button-secondary" onClick={exportTrialBalance}>Download trial balance</button>
          <button className="button button-secondary" onClick={exportIncome}>Download income statement</button>
          <button className="button button-secondary" onClick={exportBalanceSheet}>Download balance sheet</button>
        </div>
      </section>
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-heading"><h2>Trial balance</h2><span>All entries through {range.to}</span></div>
        {!data.trialBalanceReconciliation.isBalanced && <div className="alert alert-error" role="alert">
          Trial balance does not balance. Debits are {money(data.trialBalanceReconciliation.debitsZmw)} and credits are {money(data.trialBalanceReconciliation.creditsZmw)}. Difference: {money(data.trialBalanceReconciliation.differenceZmw)}.
        </div>}
        <div className="table-wrap"><table><thead><tr><th>Code</th><th>Account</th><th>Type</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>
          {data.trialBalance.map((row) => <tr key={row.accountId}><td>{row.code}</td><td>{row.name}</td><td>{row.type}</td><td>{money(row.debitZmw)}</td><td>{money(row.creditZmw)}</td><td>{money(row.balanceZmw)}</td></tr>)}
          <tr><th colSpan={3}>Totals</th><th>{money(data.totals.trialDebitsZmw)}</th><th>{money(data.totals.trialCreditsZmw)}</th><th /></tr>
        </tbody></table></div>
      </section>
      <section className="dashboard-lower" style={{ marginBottom: 16 }}>
        <div className="panel"><div className="panel-heading"><h2>Income statement</h2></div><div className="table-wrap"><table><thead><tr><th>Account</th><th>Type</th><th>Amount</th></tr></thead><tbody>{data.incomeStatement.map((row) => <tr key={row.code}><td>{row.code} · {row.name}</td><td>{row.type}</td><td>{money(row.amountZmw)}</td></tr>)}</tbody></table></div></div>
        <div className="panel">
          <div className="panel-heading"><h2>Balance sheet</h2></div>
          {!data.balanceSheetReconciliation.isBalanced && <div className="alert alert-error" role="alert">
            Balance sheet does not balance. Total assets are {money(data.balanceSheetReconciliation.assetsZmw)}, while liabilities and equity total {money(data.balanceSheetReconciliation.liabilitiesAndEquityZmw)}. Difference: {money(data.balanceSheetReconciliation.differenceZmw)}.
          </div>}
          {!data.balanceSheetReconciliation.isBalanced && data.balanceSheetDiagnostics.length > 0 && <div className="table-wrap">
            <table><thead><tr><th>Entry date</th><th>Journal entry</th><th>Difference contribution</th><th>Review</th></tr></thead><tbody>
              {data.balanceSheetDiagnostics.map((entry) => <tr key={entry.entryId}>
                <td>{entry.entryDate}</td><td>{entry.entryNumber}</td>
                <td>{entry.hasUnknownAccount ? "Includes an unavailable account" : money(entry.differenceZmw)}</td>
                <td><a href={`/accounting?journalEntryId=${entry.entryId}`}>Open entry</a></td>
              </tr>)}
            </tbody></table>
          </div>}
          <div className="table-wrap"><table><thead><tr><th>Account</th><th>Type</th><th>Amount</th></tr></thead><tbody>{data.balanceSheet.map((row, index) => <tr key={`${row.code}-${index}`}><td>{row.code} {row.name}</td><td>{row.type}</td><td>{money(row.amountZmw)}</td></tr>)}</tbody></table></div>
        </div>
      </section>
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-heading"><h2>Filter journal history</h2></div>
      <form className="panel-body form-grid" onSubmit={(event) => {
        event.preventDefault();
        const orderReference = purchaseOrderFilter.trim();
        const shipmentReference = shipmentFilter.trim();
        if (orderReference && shipmentReference) {
          setError("Filter by a purchase order or a shipment, not both.");
          return;
        }
        setError("");
        setRange((current) => ({
          ...current,
          purchaseOrder: orderReference,
          shipment: shipmentReference,
        }));
      }}>
        <p className="report-footnote" style={{ gridColumn: "1 / -1" }}>
          These filters narrow the journal list only; the accounting reports above keep their full date-range totals.
          Enter one exact purchase order or shipment reference at a time.
        </p>
        <label>Purchase order reference<input value={purchaseOrderFilter} maxLength={120}
          onChange={(event) => setPurchaseOrderFilter(event.target.value)} placeholder="For example, PO-001" /></label>
        <label>Shipment reference<input value={shipmentFilter} maxLength={120}
          onChange={(event) => setShipmentFilter(event.target.value)} placeholder="Enter the shipment reference" /></label>
        <div className="toolbar">
          <button className="button button-primary">Apply journal filters</button>
          <button className="button button-secondary" type="button" onClick={() => {
            setPurchaseOrderFilter("");
            setShipmentFilter("");
            setRange((current) => ({ ...current, purchaseOrder: "", shipment: "" }));
          }}>Clear filters</button>
        </div>
      </form>
    </section>
    <section className="panel">
        <div className="panel-heading"><h2>Journal entries in period</h2><span>{data.entries.length} entries</span></div>
      {(range.purchaseOrder || range.shipment) && <p className="report-footnote" role="status">
        Filtered by {[
          range.purchaseOrder ? `purchase order ${range.purchaseOrder}` : "",
          range.shipment ? `shipment ${range.shipment}` : "",
        ].filter(Boolean).join(" and ")}.
      </p>}
        <div className="table-wrap"><table><thead><tr><th>Date / entry</th><th>Details</th><th>Account</th><th>Debit</th><th>Credit</th></tr></thead><tbody>
          {data.entries.flatMap((entry) => entry.lines.map((line, index) => <tr key={`${entry.id}-${index}`}>
            <td>{index === 0 ? <>{entry.entryDate}<br /><small>{entry.entryNumber}</small></> : null}</td>
            <td>{index === 0 ? entry.memo : line.description}</td><td>{line.accountCode} · {line.accountName}</td>
            <td>{line.debitZmw !== "0.00" ? money(line.debitZmw) : "—"}</td><td>{line.creditZmw !== "0.00" ? money(line.creditZmw) : "—"}</td>
          </tr>))}
          {!data.entries.length && <tr><td colSpan={5}>{range.purchaseOrder || range.shipment
            ? "No journal entries match these references in this period."
            : "No accounting entries in this period."}</td></tr>}
        </tbody></table></div>
      </section>
    </>}
  </>;
}
