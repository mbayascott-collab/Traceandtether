import { useEffect, useState } from "react";

type ReportRow = { code: string; name: string; type: string; amountZmw: string };
type TrialRow = ReportRow & { accountId: number; debitZmw: string; creditZmw: string; balanceZmw: string };
type JournalEntry = {
  id: number; entryNumber: string; memo: string; entryDate: string; sourceType: string;
  lines: Array<{ accountCode: string; accountName: string; debitZmw: string; creditZmw: string; description: string | null }>;
};
type ReportData = {
  entries: JournalEntry[];
  trialBalance: TrialRow[];
  incomeStatement: ReportRow[];
  balanceSheet: ReportRow[];
  totals: { trialDebitsZmw: string; trialCreditsZmw: string; incomeZmw: string; expensesZmw: string; netIncomeZmw: string };
};

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

export default function AccountingWorkspace() {
  const [from, setFrom] = useState(`${currentYear}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [range, setRange] = useState({ from: `${currentYear}-01-01`, to: new Date().toISOString().slice(0, 10) });
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError("");
    fetch(`/api/accounting?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`)
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Accounting records could not be loaded.");
        if (alive) setData(result);
      })
      .catch((reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : "Accounting records could not be loaded."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [range]);

  const exportJournal = () => downloadCsv("journal-entries.csv", [
    ["Date", "Entry number", "Source", "Memo", "Account code", "Account", "Description", "Debit ZMW", "Credit ZMW"],
    ...(data?.entries.flatMap((entry) => entry.lines.map((line) => [
      entry.entryDate, entry.entryNumber, entry.sourceType, entry.memo, line.accountCode, line.accountName,
      line.description, line.debitZmw, line.creditZmw,
    ])) ?? []),
  ]);
  const exportTrialBalance = () => downloadCsv("trial-balance.csv", [
    ["Code", "Account", "Type", "Debit ZMW", "Credit ZMW", "Balance ZMW"],
    ...(data?.trialBalance.map((row) => [row.code, row.name, row.type, row.debitZmw, row.creditZmw, row.balanceZmw]) ?? []),
  ]);
  const exportIncome = () => downloadCsv("income-statement.csv", [
    ["Code", "Account", "Type", "Amount ZMW"],
    ...(data?.incomeStatement.map((row) => [row.code, row.name, row.type, row.amountZmw]) ?? []),
  ]);
  const exportBalanceSheet = () => downloadCsv("balance-sheet.csv", [
    ["Code", "Account", "Type", "Amount ZMW"],
    ...(data?.balanceSheet.map((row) => [row.code, row.name, row.type, row.amountZmw]) ?? []),
  ]);

  return <>
    <section className="page-heading"><div><p className="eyebrow">Finance · ZMW</p><h1>Accounting</h1><p>Review and export the records posted from business activity.</p></div></section>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    <section className="panel form-grid" style={{ padding: 16, marginBottom: 16 }}>
      <h2>Year-end report period</h2>
      <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>Through<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <button className="button button-primary" onClick={() => setRange({ from, to })}>Run reports</button>
    </section>
    <div className="notice-strip" style={{ marginBottom: 16 }}>
      These reports include entries already recorded in the app. Opening balances, tax treatment, bank reconciliation, and accountant review still need to be completed before relying on this as a full year-end filing.
    </div>
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
        <div className="table-wrap"><table><thead><tr><th>Code</th><th>Account</th><th>Type</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>
          {data.trialBalance.map((row) => <tr key={row.accountId}><td>{row.code}</td><td>{row.name}</td><td>{row.type}</td><td>{money(row.debitZmw)}</td><td>{money(row.creditZmw)}</td><td>{money(row.balanceZmw)}</td></tr>)}
          <tr><th colSpan={3}>Totals</th><th>{money(data.totals.trialDebitsZmw)}</th><th>{money(data.totals.trialCreditsZmw)}</th><th /></tr>
        </tbody></table></div>
      </section>
      <section className="dashboard-lower" style={{ marginBottom: 16 }}>
        <div className="panel"><div className="panel-heading"><h2>Income statement</h2></div><div className="table-wrap"><table><thead><tr><th>Account</th><th>Type</th><th>Amount</th></tr></thead><tbody>{data.incomeStatement.map((row) => <tr key={row.code}><td>{row.code} · {row.name}</td><td>{row.type}</td><td>{money(row.amountZmw)}</td></tr>)}</tbody></table></div></div>
        <div className="panel"><div className="panel-heading"><h2>Balance sheet</h2></div><div className="table-wrap"><table><thead><tr><th>Account</th><th>Type</th><th>Amount</th></tr></thead><tbody>{data.balanceSheet.map((row, index) => <tr key={`${row.code}-${index}`}><td>{row.code} {row.name}</td><td>{row.type}</td><td>{money(row.amountZmw)}</td></tr>)}</tbody></table></div></div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>Journal entries in period</h2><span>{data.entries.length} entries</span></div>
        <div className="table-wrap"><table><thead><tr><th>Date / entry</th><th>Details</th><th>Account</th><th>Debit</th><th>Credit</th></tr></thead><tbody>
          {data.entries.flatMap((entry) => entry.lines.map((line, index) => <tr key={`${entry.id}-${index}`}>
            <td>{index === 0 ? <>{entry.entryDate}<br /><small>{entry.entryNumber}</small></> : null}</td>
            <td>{index === 0 ? entry.memo : line.description}</td><td>{line.accountCode} · {line.accountName}</td>
            <td>{line.debitZmw !== "0.00" ? money(line.debitZmw) : "—"}</td><td>{line.creditZmw !== "0.00" ? money(line.creditZmw) : "—"}</td>
          </tr>))}
          {!data.entries.length && <tr><td colSpan={5}>No accounting entries in this period.</td></tr>}
        </tbody></table></div>
      </section>
    </>}
  </>;
}
