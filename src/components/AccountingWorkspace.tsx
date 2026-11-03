import { useEffect, useState } from "react";

type Account = { id: number; code: string; name: string; type: string; balanceZmw: string };
type Entry = {
  id: number; entryNumber: string; memo: string; entryDate: string; sourceType: string;
  lines: Array<{ accountCode: string; accountName: string; debitZmw: string; creditZmw: string; description: string | null }>;
};

function money(value: string) {
  const amount = Number(value);
  return `ZMW ${amount.toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function AccountingWorkspace() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/accounting")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Accounting data could not be loaded.");
        if (alive) {
          setAccounts(data.accounts);
          setEntries(data.entries);
        }
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : "Accounting data could not be loaded.");
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Finance · ZMW</p><h1>Accounting</h1><p>Balanced journals are posted from recorded stock and sales events.</p></div>
      </section>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="notice-strip" style={{ marginBottom: 20 }}>
        <span>Unpaid amounts remain in payables and receivables. Enter import costs before posting stock receipts; later costs stay in clearing. Historical opening balances, payment settlement, tax, and bank reconciliation are not included yet.</span>
      </div>
      <section className="panel">
        <div className="panel-heading"><h2>Chart of accounts</h2><span>{accounts.length} accounts</span></div>
        {loading ? <div className="panel-body">Loading accounts…</div> : (
          <div className="table-wrap">
            <table><thead><tr><th>Code</th><th>Account</th><th>Type</th><th>Balance</th></tr></thead>
              <tbody>{accounts.map((account) => <tr key={account.id}><td>{account.code}</td><td>{account.name}</td><td>{account.type}</td><td>{money(account.balanceZmw)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-heading"><h2>Recent journal entries</h2><span>Latest 100</span></div>
        {entries.length === 0 ? <div className="panel-body"><div className="empty-state"><h3>No entries posted yet</h3><p>Posting an import cost, stock receipt, or fulfilled sales order will create journal entries here.</p></div></div> : (
          <div className="table-wrap">
            <table><thead><tr><th>Date / entry</th><th>Details</th><th>Account</th><th>Debit</th><th>Credit</th></tr></thead>
              <tbody>{entries.flatMap((entry) => entry.lines.map((line, index) => <tr key={`${entry.id}-${index}`}>
                <td>{index === 0 ? <>{entry.entryDate}<br /><small>{entry.entryNumber}</small></> : null}</td>
                <td>{index === 0 ? entry.memo : line.description}</td>
                <td>{line.accountCode} · {line.accountName}</td>
                <td>{line.debitZmw !== "0.00" ? money(line.debitZmw) : "—"}</td>
                <td>{line.creditZmw !== "0.00" ? money(line.creditZmw) : "—"}</td>
              </tr>))}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
