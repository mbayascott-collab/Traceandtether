import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";

type ReconciliationAccount = { id: number; code: string; name: string; systemKey: string };
type Payment = {
  id: number; paymentNumber: string; paymentDate: string; amountZmw: string;
  method: string; direction: "customer_receipt" | "supplier_payment"; reference: string | null;
  orderNumber: string; partyName: string; matched: boolean; duplicateLike: boolean;
};
type StatementLine = {
  id: number; transactionDate: string; flow: "in" | "out"; amountZmw: string;
  description: string; reference: string | null; matchedPaymentId: number | null; duplicateLike: boolean;
  matchedPayment: (Pick<Payment, "id" | "paymentNumber" | "paymentDate" | "amountZmw" | "method" | "direction" | "reference" | "orderNumber" | "partyName">) | null;
};
type ReconciliationData = { lines: StatementLine[]; payments: Payment[] };
type CsvLine = { transactionDate: string; flow: "in" | "out"; amountZmw: string; description: string; reference: string };

const today = () => new Date().toISOString().slice(0, 10);
const money = (value: string) => `ZMW ${Number(value).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const amountCents = (value: string) => Math.round(Number(value) * 100);
const sameReference = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase().replace(/\s+/g, " ") === (b ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const flowName = (flow: "in" | "out") => flow === "in" ? "Money in" : "Money out";

function parseCsv(text: string): CsvLine[] {
  const rows: string[][] = [];
  let row: string[] = [], value = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') { value += '"'; index++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(value.trim()); value = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(value.trim()); value = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else value += char;
  }
  if (quoted) throw new Error("The CSV has an unfinished quoted field.");
  row.push(value.trim());
  if (row.some((cell) => cell !== "")) rows.push(row);
  if (rows.length < 2) throw new Error("Add a CSV header and at least one statement line.");
  const headers = rows[0].map((header) => header.toLowerCase().replace(/[\s_-]+/g, ""));
  const indexOf = (...names: string[]) => headers.findIndex((header) => names.includes(header));
  const dateIndex = indexOf("date", "transactiondate");
  const flowIndex = indexOf("flow", "type", "direction");
  const amountIndex = indexOf("amount", "amountzmw");
  const descriptionIndex = indexOf("description", "details", "narration");
  const referenceIndex = indexOf("reference", "ref", "transactionreference");
  if (dateIndex < 0 || flowIndex < 0 || amountIndex < 0) {
    throw new Error("CSV needs date, flow, and amount columns. Description and reference are optional.");
  }
  return rows.slice(1).map((cells, rowIndex) => {
    const flowText = (cells[flowIndex] ?? "").trim().toLowerCase();
    const flow = ["in", "credit", "deposit", "received", "money in"].includes(flowText) ? "in"
      : ["out", "debit", "withdrawal", "paid", "money out"].includes(flowText) ? "out" : null;
    const amountText = (cells[amountIndex] ?? "").replaceAll(",", "").replace(/^ZMW\s*/i, "").trim();
    if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(amountText) || Number(amountText) <= 0) {
      throw new Error(`CSV row ${rowIndex + 2} has an invalid positive amount.`);
    }
    const date = cells[dateIndex] ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
      throw new Error(`CSV row ${rowIndex + 2} needs a date in YYYY-MM-DD format.`);
    }
    if (!flow) throw new Error(`CSV row ${rowIndex + 2} flow must be in/credit or out/debit.`);
    return {
      transactionDate: date, flow, amountZmw: Number(amountText).toFixed(2),
      description: descriptionIndex < 0 ? "" : cells[descriptionIndex] ?? "",
      reference: referenceIndex < 0 ? "" : cells[referenceIndex] ?? "",
    };
  });
}

export default function PaymentReconciliation() {
  const [accounts, setAccounts] = useState<ReconciliationAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(today());
  const [range, setRange] = useState({ from: `${new Date().getFullYear()}-01-01`, to: today() });
  const [data, setData] = useState<ReconciliationData>({ lines: [], payments: [] });
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedPayments, setSelectedPayments] = useState<Record<number, string>>({});

  useEffect(() => {
    fetch("/api/payments/reconciliation/accounts").then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load accounts.");
      setAccounts(result.accounts);
      if (result.accounts.length) setAccountId(String(result.accounts[0].id));
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not load accounts."));
  }, []);

  useEffect(() => {
    if (!accountId || !range.from || !range.to) return;
    let active = true;
    setLoading(true); setError("");
    fetch(`/api/payments/reconciliation?accountId=${encodeURIComponent(accountId)}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`)
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not load reconciliation details.");
        if (active) { setData(result); setSelectedPayments({}); }
      })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load reconciliation details."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [accountId, range, reload]);

  const usablePayments = useMemo(() => {
    return data.payments.filter((payment) => !payment.matched);
  }, [data]);

  function recommendedPayment(line: StatementLine) {
    const ranked = usablePayments.map((payment) => {
      const amountMatches = amountCents(payment.amountZmw) === amountCents(line.amountZmw);
      const dateMatches = payment.paymentDate === line.transactionDate;
      const referenceMatches = Boolean(line.reference && sameReference(payment.reference, line.reference));
      const flowMatches = (payment.direction === "customer_receipt") === (line.flow === "in");
      const score = (amountMatches ? 4 : 0) + (dateMatches ? 2 : 0) + (referenceMatches ? 5 : 0) + (flowMatches ? 1 : 0);
      return { payment, score, amountMatches, dateMatches, referenceMatches };
    }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score);
    if (!ranked.length || (ranked[1]?.score === ranked[0].score)) return "";
    return ranked[0].payment.id;
  }

  async function addLines(lines: CsvLine[]) {
    if (!accountId) throw new Error("Choose an account first.");
    if (range.from > range.to) throw new Error("Start date must be on or before end date.");
    const response = await fetch("/api/payments/reconciliation/lines", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: Number(accountId), ...range, lines }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Statement lines could not be saved.");
    setNotice(`${result.added} statement line${result.added === 1 ? "" : "s"} added. Entries were not changed.`);
    setReload((value) => value + 1);
  }

  async function importCsv(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setBusy(true); setError(""); setNotice("");
    try { await addLines(parseCsv(await file.text())); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "CSV could not be imported."); }
    finally { setBusy(false); input.value = ""; }
  }

  async function enterLine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      await addLines([{
        transactionDate: String(values.get("statementDate")), flow: String(values.get("flow")) as "in" | "out",
        amountZmw: String(values.get("statementAmount")), description: String(values.get("description") ?? ""),
        reference: String(values.get("reference") ?? ""),
      }]);
      form.reset();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Statement line could not be added."); }
    finally { setBusy(false); }
  }

  async function setMatch(lineId: number, paymentId: number | null) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/payments/reconciliation/match", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineId, paymentId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The match could not be saved.");
      setNotice(paymentId === null ? "Match removed. The journal was not changed." : "Match saved. The journal was not changed.");
      setReload((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The match could not be saved."); }
    finally { setBusy(false); }
  }

  return <section className="panel form-grid" aria-labelledby="reconciliation-heading">
    <div>
      <h2 id="reconciliation-heading">Match statement lines</h2>
      <p className="report-footnote">Add a bank or mobile money statement, then match lines to recorded payments. Matching only marks the comparison; it never changes journal entries.</p>
    </div>
    {error && <div className="notice-strip" role="alert">{error}</div>}
    {notice && <div className="notice-strip" role="status">{notice}</div>}
    {!accounts.length ? <p className="report-footnote">No supported cash, bank, or mobile money accounts are available.</p> : <>
      <label>Account<select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
        {accounts.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
      </select></label>
      <div className="form-grid" style={{ gridTemplateColumns: "1fr" }}>
        <label>From date<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>Through date<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <button className="button button-secondary" type="button" onClick={() => setRange({ from, to })}>Show this date range</button>
      </div>
      <div className="form-grid" style={{ gridTemplateColumns: "1fr" }}>
        <label>Import CSV statement<input type="file" accept=".csv,text/csv" disabled={busy} onChange={importCsv} /></label>
        <p className="report-footnote">CSV columns: date, flow, amount; optional description and reference. Use YYYY-MM-DD and in/credit or out/debit. Lines must fall within the selected date range.</p>
      </div>
      <form className="form-grid" style={{ gridTemplateColumns: "1fr" }} onSubmit={enterLine}>
        <h3>Enter a statement line</h3>
        <label>Date<input name="statementDate" type="date" min={range.from} max={range.to} defaultValue={range.to} required /></label>
        <label>Money movement<select name="flow" defaultValue="in"><option value="in">Money in</option><option value="out">Money out</option></select></label>
        <label>Amount (ZMW)<input name="statementAmount" type="number" min="0.01" step="0.01" required /></label>
        <label>Description<input name="description" maxLength={240} /></label>
        <label>Reference<input name="reference" maxLength={120} /></label>
        <button className="button button-primary" disabled={busy}>{busy ? "Saving…" : "Add statement line"}</button>
      </form>

      <div className="data-table-wrap">
        <h3>Statement lines {loading ? "· Loading…" : `· ${data.lines.length}`}</h3>
        <table><thead><tr><th>Date and details</th><th>Flow</th><th>Statement amount</th><th>Recorded payment</th><th>Review</th><th>Action</th></tr></thead>
          <tbody>{data.lines.map((line) => {
            const chosenId = selectedPayments[line.id] ?? (line.matchedPaymentId ?? recommendedPayment(line) ?? "");
            const chosen = usablePayments.find((payment) => String(payment.id) === String(chosenId)) ?? line.matchedPayment;
            const amountMismatch = chosen && amountCents(chosen.amountZmw) !== amountCents(line.amountZmw);
            const dateMismatch = chosen && chosen.paymentDate !== line.transactionDate;
            const flowMismatch = chosen && (chosen.direction === "customer_receipt") !== (line.flow === "in");
            return <tr key={line.id}>
              <td>{line.transactionDate}<br />{line.description || "—"}{line.reference ? <><br /><small>Ref: {line.reference}</small></> : null}</td>
              <td>{flowName(line.flow)}</td><td>{money(line.amountZmw)}</td>
              <td>
                <select aria-label={`Payment match for ${line.transactionDate}`} value={chosenId}
                  disabled={Boolean(line.matchedPaymentId) || busy}
                  onChange={(event) => setSelectedPayments((current) => ({ ...current, [line.id]: event.target.value }))}>
                  <option value="">Choose a recorded payment</option>
                  {line.matchedPayment && <option value={line.matchedPayment.id}>
                    {line.matchedPayment.paymentNumber} · {line.matchedPayment.paymentDate} · {money(line.matchedPayment.amountZmw)}
                  </option>}
                  {usablePayments.map((payment) => <option key={payment.id} value={payment.id}>
                    {payment.paymentNumber} · {payment.paymentDate} · {money(payment.amountZmw)} · {payment.partyName} · {payment.orderNumber}
                  </option>)}
                </select>
                {line.matchedPayment && <span>{line.matchedPayment.paymentNumber} · {money(line.matchedPayment.amountZmw)}</span>}
              </td>
              <td>{line.matchedPaymentId ? "Matched" : "Unmatched"}
                {line.duplicateLike && <><br /><strong>Possible duplicate statement line</strong></>}
                {chosen && amountMismatch && <><br /><strong>Amount differs</strong></>}
                {chosen && dateMismatch && <><br /><strong>Date differs</strong></>}
                {chosen && flowMismatch && <><br /><strong>Money direction differs</strong></>}
              </td>
              <td>{line.matchedPaymentId
                ? <button className="button button-secondary button-small" disabled={busy} onClick={() => setMatch(line.id, null)}>Unmatch</button>
                : <button className="button button-primary button-small" disabled={busy || !chosenId} onClick={() => setMatch(line.id, Number(chosenId))}>Match</button>}</td>
            </tr>;
          })}
          {!data.lines.length && <tr><td colSpan={6}>{loading ? "Loading statement lines…" : "No statement lines in this account and date range."}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="data-table-wrap">
        <h3>Recorded payments to review</h3>
        <p className="report-footnote">Payments are listed for this account and within seven days of the selected range. Unmatched entries may be missing from the statement.</p>
        <table><thead><tr><th>Payment</th><th>Date</th><th>Customer / supplier</th><th>Order</th><th>Direction</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>{data.payments.filter((payment) => !payment.matched).map((payment) => (
            <tr key={payment.id}><td>{payment.paymentNumber}</td><td>{payment.paymentDate}</td><td>{payment.partyName}</td>
              <td>{payment.orderNumber}</td><td>{payment.direction === "customer_receipt" ? "Money in" : "Money out"}</td>
              <td>{money(payment.amountZmw)}</td><td>Unmatched{payment.duplicateLike ? " · Possible duplicate payment" : ""}</td></tr>
          ))}
          {!data.payments.some((payment) => !payment.matched) && <tr><td colSpan={7}>No unmatched payments in this account and date window.</td></tr>}
          </tbody>
        </table>
      </div>
    </>}
  </section>;
}
