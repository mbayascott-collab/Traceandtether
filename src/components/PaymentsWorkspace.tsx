import { useEffect, useState, type FormEvent } from "react";
import type { BusinessPayment, PaymentDirection, PaymentOverview } from "../lib/api";

const money = (value: string) => `ZMW ${Number(value).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);

export default function PaymentsWorkspace() {
  const [data, setData] = useState<PaymentOverview>({ payments: [], invoices: [], bills: [] });
  const [direction, setDirection] = useState<PaymentDirection>("customer_receipt");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const options = direction === "customer_receipt" ? data.invoices : data.bills;
  const pendingBalances = [
    ...data.invoices.map((item) => ({ ...item, balanceType: "Customer owes us" })),
    ...data.bills.map((item) => ({ ...item, balanceType: "We owe supplier" })),
  ].sort((a, b) => Number(b.outstandingZmw) - Number(a.outstandingZmw));

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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setBusy(true); setError(""); setNotice("");
    const form = new FormData(formElement);
    try {
      const response = await fetch("/api/payments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direction, orderId: Number(form.get("orderId")), amountZmw: String(form.get("amountZmw")),
          paymentDate: String(form.get("paymentDate")), method: String(form.get("method")),
          reference: String(form.get("reference") || ""), notes: String(form.get("notes") || ""),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save the payment.");
      setNotice(`${result.payment.paymentNumber} saved.`);
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
        <label>Amount received (ZMW)<input name="amountZmw" type="number" min="0.01" step="0.01" required /></label>
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
      <p className="report-footnote">Payments are recorded in ZMW. Supplier payments are matched to received purchase-order stock.</p>
    </div>
    <div className="panel data-table-wrap">
      <h2>Pending payments</h2>
      <p className="report-footnote">These balances are still unpaid. Customer balances include goods already delivered.</p>
      <table><thead><tr><th>Type</th><th>Customer / supplier</th><th>Order</th><th>Total</th><th>Paid</th><th>Still owed</th></tr></thead>
        <tbody>{pendingBalances.map((item) => <tr key={`${item.balanceType}-${item.orderId}`}>
          <td>{item.balanceType}</td><td>{item.partyName}</td><td>{item.orderNumber}</td>
          <td>{money(item.totalZmw)}</td><td>{money(item.paidZmw)}</td><td><strong>{money(item.outstandingZmw)}</strong></td>
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
