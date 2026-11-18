import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BusinessPayment, PaymentDirection, PaymentOption, PaymentOverview } from "../lib/api";

const money = (value: string) => `ZMW ${Number(value).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);
const agingLabels = {
  not_due: "Not due",
  "1_30_days": "1–30 days",
  "31_60_days": "31–60 days",
  over_60_days: "Over 60 days",
} as const;

export default function PaymentsWorkspace() {
  const [data, setData] = useState<PaymentOverview>({ payments: [], invoices: [], bills: [] });
  const [direction, setDirection] = useState<PaymentDirection>("customer_receipt");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [dueDateDrafts, setDueDateDrafts] = useState<Record<string, string>>({});
  const [savingDueDate, setSavingDueDate] = useState("");
  const pendingAttempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const options = direction === "customer_receipt" ? data.invoices : data.bills;
  const pendingBalances = [
    ...data.invoices.map((item) => ({ ...item, direction: "customer_receipt" as const, balanceType: "Customer owes us" })),
    ...data.bills.map((item) => ({ ...item, direction: "supplier_payment" as const, balanceType: "We owe supplier" })),
  ].sort((a, b) => Number(b.outstandingZmw) - Number(a.outstandingZmw));
  const agingTotals = (["not_due", "1_30_days", "31_60_days", "over_60_days"] as const).map((bucket) => ({
    bucket,
    amountCents: pendingBalances.reduce((total, item) => item.agingBucket === bucket
      ? total + Math.round(Number(item.outstandingZmw) * 100)
      : total, 0),
  }));

  useEffect(() => {
    let active = true;
    fetch("/api/payments").then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load payments.");
      if (active) setData(result);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load payments.");
    });
    return () => { active = false; };
  }, [reload]);

  async function saveDueDate(direction: PaymentDirection, item: PaymentOption) {
    const key = `${direction}-${item.orderId}`;
    setSavingDueDate(key); setError(""); setNotice("");
    try {
      const response = await fetch("/api/payments/due-date", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction, orderId: item.orderId, dueDate: dueDateDrafts[key] || item.dueDate }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save the due date.");
      setNotice(`Due date saved for ${item.orderNumber}.`);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the due date.");
    } finally { setSavingDueDate(""); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setBusy(true); setError(""); setNotice("");
    const form = new FormData(formElement);
    const paymentDetails = {
      direction, orderId: Number(form.get("orderId")), amountZmw: String(form.get("amountZmw")),
      paymentDate: String(form.get("paymentDate")), method: String(form.get("method")),
      reference: String(form.get("reference") || ""), notes: String(form.get("notes") || ""),
    };
    const fingerprint = JSON.stringify(paymentDetails);
    if (pendingAttempt.current?.fingerprint !== fingerprint) {
      pendingAttempt.current = { fingerprint, key: crypto.randomUUID() };
    }
    try {
      const response = await fetch("/api/payments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...paymentDetails, idempotencyKey: pendingAttempt.current.key }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save the payment.");
      setNotice(`${result.payment.paymentNumber} saved.`);
      pendingAttempt.current = null;
      formElement.reset();
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the payment.");
    } finally { setBusy(false); }
  }

  return <section className="supplier-workspace">
    <header className="page-heading"><div><p className="eyebrow">Finance · ZMW</p><h1>Payments</h1><p>Record customer money received and payments made to suppliers.</p></div></header>
    {error && <div className="notice-strip" role="alert">{error}</div>}
    {notice && <div className="notice-strip" role="status">{notice}</div>}
    <div className="panel form-grid">
      <h2>Record a payment</h2>
      <label>Payment type<select value={direction} onChange={(event) => setDirection(event.target.value as PaymentDirection)}>
        <option value="customer_receipt">Money received from customer</option>
        <option value="supplier_payment">Money paid to supplier</option>
      </select></label>
      <form key={direction} className="form-grid payment-form" onSubmit={submit}>
          <label>{direction === "customer_receipt" ? "Customer order balance" : "Supplier purchase order"}
          <select name="orderId" required defaultValue="">
            <option value="">Choose an outstanding balance</option>
            {options.map((option) => <option key={option.orderId} value={option.orderId}>
              {option.partyName} · {option.orderNumber} · owes {money(option.outstandingZmw)}
            </option>)}
          </select>
        </label>
        <label>Amount {direction === "customer_receipt" ? "received" : "paid"} (ZMW)<input name="amountZmw" type="number" min="0.01" step="0.01" required /></label>
        <label>Date<input name="paymentDate" type="date" defaultValue={today()} required /></label>
        <label>How was it paid?<select name="method" defaultValue="cash" required>
          <option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option>
          <option value="mobile_money">Mobile money</option><option value="other">Other</option>
        </select></label>
        <label>Payment reference<input name="reference" maxLength={120} placeholder="Optional transaction number" /></label>
        <label>Notes<input name="notes" maxLength={1000} placeholder="Optional" /></label>
        <button className="button button-primary" disabled={busy || !options.length}>{busy ? "Saving…" : "Save payment"}</button>
      </form>
      {!options.length && <p className="report-footnote">No outstanding balances are available for this payment type.</p>}
      <p className="report-footnote">Payments are recorded in ZMW. Supplier balances include received goods and recorded import costs.</p>
    </div>
    <div className="panel data-table-wrap">
      <h2>Pending payments</h2>
      <p className="report-footnote">These balances are still unpaid. Customer balances include goods already delivered. Aging is based on the due date.</p>
      <table className="aging-summary"><thead><tr><th>Not due</th><th>1–30 days overdue</th><th>31–60 days overdue</th><th>Over 60 days overdue</th></tr></thead>
        <tbody><tr>{agingTotals.map(({ bucket, amountCents }) => <td key={bucket}><strong>{money((amountCents / 100).toFixed(2))}</strong></td>)}</tr></tbody>
      </table>
      <table><thead><tr><th>Type</th><th>Customer / supplier</th><th>Order</th><th>Total</th><th>Paid</th><th>Still owed</th><th>Aging</th><th>Due date</th></tr></thead>
        <tbody>{pendingBalances.map((item) => <tr key={`${item.balanceType}-${item.orderId}`}>
          <td>{item.balanceType}</td><td>{item.partyName}</td><td>{item.orderNumber}</td>
          <td>{money(item.totalZmw)}</td><td>{money(item.paidZmw)}</td><td><strong>{money(item.outstandingZmw)}</strong></td>
          <td>{agingLabels[item.agingBucket]}{item.overdueDays > 0 ? ` · ${item.overdueDays} days` : ""}</td>
          <td><div className="form-grid payment-due-date">
            <input aria-label={`Due date for ${item.orderNumber}`} type="date"
              value={dueDateDrafts[`${item.direction}-${item.orderId}`] ?? item.dueDate}
              onChange={(event) => setDueDateDrafts((drafts) => ({ ...drafts, [`${item.direction}-${item.orderId}`]: event.target.value }))} />
            <button className="button button-secondary button-small" disabled={savingDueDate === `${item.direction}-${item.orderId}`}
              onClick={() => saveDueDate(item.direction, item)}>{savingDueDate === `${item.direction}-${item.orderId}` ? "Saving…" : "Save date"}</button>
          </div></td>
        </tr>)}</tbody>
      </table>
      {!pendingBalances.length && <p className="report-footnote">There are no unpaid customer or supplier balances.</p>}
    </div>
    <div className="panel data-table-wrap">
      <h2>Payment history</h2>
      <table><thead><tr><th>Payment</th><th>Date</th><th>Customer / supplier</th><th>Order</th><th>Type</th><th>Method</th><th>Reference</th><th>Amount</th></tr></thead>
        <tbody>{data.payments.map((payment: BusinessPayment) => <tr key={payment.id}>
          <td>{payment.paymentNumber}</td><td>{payment.paymentDate}</td><td>{payment.partyName}</td><td>{payment.orderNumber}</td>
          <td>{payment.direction === "customer_receipt" ? "Received" : "Paid"}</td>
          <td>{payment.method.replace("_", " ")}</td><td>{payment.reference || "—"}</td><td>{money(payment.amountZmw)}</td>
        </tr>)}</tbody>
      </table>
      {!data.payments.length && <p className="report-footnote">No payments recorded yet.</p>}
    </div>
  </section>;
}
