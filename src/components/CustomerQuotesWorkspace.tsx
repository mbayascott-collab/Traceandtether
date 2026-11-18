import { useEffect, useState, type FormEvent } from "react";
import { convertCustomerQuote, deleteCustomerQuote, fetchCustomerQuotes, fetchCustomers, fetchProducts, saveCustomerQuote, type Customer, type CustomerQuote, type CustomerQuoteInput, type Product } from "../lib/api";
import companyLogo from "../../attached_assets/google_profile_1793771922305.png";

type DraftLine = { productId: string; quantity: string; unitPriceZmw: string };
const blankLine = (): DraftLine => ({ productId: "", quantity: "1", unitPriceZmw: "" });
const money = (value: string) => `ZMW ${Number(value).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const companyName = "Trace and Tether Craft Studio Limited";
const companyAddress = "164 Mpundu Street, Chelston Extension, Lusaka, Zambia";
const companyEmail = "traceandtether@gmail.com";
const companyPhone = "+260-0977-101-967";
const emptyInput: CustomerQuoteInput = { customerId: 0, validUntil: null, deliveryAddress: null, notes: null, status: "draft", lines: [] };

export default function CustomerQuotesWorkspace() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [quotes, setQuotes] = useState<CustomerQuote[]>([]);
  const [printQuote, setPrintQuote] = useState<CustomerQuote | null>(null);
  const [editing, setEditing] = useState<CustomerQuote | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    Promise.all([fetchCustomers(), fetchProducts({ page: 1, pageSize: 100 }), fetchCustomerQuotes()])
      .then(([c, p, q]) => { if (alive) { setCustomers(c); setProducts(p.products); setQuotes(q); } })
      .catch((cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : "Could not load customer quotes."); });
    return () => { alive = false; };
  }, [reload]);

  function editQuote(quote: CustomerQuote) {
    setEditing(quote);
    setLines(quote.lines.map((line) => ({ productId: String(line.productId), quantity: String(line.quantity), unitPriceZmw: line.unitPriceZmw })));
    setError("");
  }
  function clearForm() { setEditing(null); setLines([blankLine()]); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setNotice("");
    const form = new FormData(event.currentTarget);
    const input: CustomerQuoteInput = {
      customerId: Number(form.get("customerId")), validUntil: String(form.get("validUntil") || "") || null,
      deliveryAddress: String(form.get("deliveryAddress") || "") || null, notes: String(form.get("notes") || "") || null,
      status: String(form.get("status")) as CustomerQuoteInput["status"],
      lines: lines.map((line) => ({ productId: Number(line.productId), quantity: Number(line.quantity), unitPriceZmw: line.unitPriceZmw.trim() })),
    };
    try {
      await saveCustomerQuote(input, editing?.id);
      clearForm(); setNotice(editing ? "Quote updated." : "Quote saved."); setReload((n) => n + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the quote."); }
  }
  async function convert(quote: CustomerQuote) {
    setError(""); setNotice("");
    try {
      const orderNumber = await convertCustomerQuote(quote.id);
      setNotice(`${quote.quoteNumber} was converted to draft order ${orderNumber}.`);
      setReload((n) => n + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not convert this quote."); }
  }
  async function removeQuote(quote: CustomerQuote) {
    if (!window.confirm(`Delete quote ${quote.quoteNumber}? This cannot be undone.`)) return;
    setError(""); setNotice("");
    try {
      await deleteCustomerQuote(quote.id);
      setNotice(`${quote.quoteNumber} deleted.`);
      setReload((n) => n + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete this quote."); }
  }
  function quoteDate(value: string) {
    return new Date(value).toLocaleDateString("en-ZM", { day: "numeric", month: "long", year: "numeric" });
  }
  function quoteStatusLabel(status: CustomerQuote["status"]) {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }
  function isQuoteExpired(quote: CustomerQuote) {
    if (!quote.validUntil) return false;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return quote.validUntil < today;
  }

  return <section className="supplier-workspace">
    <header className="page-heading"><div><p className="eyebrow">Sales · private records</p><h1>Customer quotes</h1><p>Prepare a price offer, mark it accepted, then turn it into a draft sales order.</p></div></header>
    {error && <div className="notice-strip" role="alert">{error}</div>}{notice && <div className="notice-strip" role="status">{notice}</div>}
    <form key={editing?.id ?? "new-quote"} className="panel form-grid" onSubmit={submit}>
      <h2>{editing ? `Edit ${editing.quoteNumber}` : "Prepare a customer quote"}</h2>
      <label>Customer<select name="customerId" required defaultValue={String(editing?.customerId ?? "")}><option value="">Select customer</option>{customers.filter((c) => c.status === "active").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Valid until<input name="validUntil" type="date" defaultValue={editing?.validUntil ?? ""} /></label>
      <label>Delivery address<input name="deliveryAddress" defaultValue={editing?.deliveryAddress ?? ""} /></label>
      <label>Status<select name="status" defaultValue={editing?.status ?? "draft"}><option value="draft">Draft</option><option value="sent">Sent outside the app</option><option value="accepted">Accepted</option><option value="rejected">Rejected</option></select></label>
      {lines.map((line, i) => <div className="form-grid customer-quote-line" key={i}>
        <label>Product<select required value={line.productId} onChange={(e) => {
          const product = products.find((p) => p.id === Number(e.target.value));
          setLines((current) => current.map((row, n) => n === i ? { ...row, productId: e.target.value, unitPriceZmw: product?.sellingPriceZmw ?? "" } : row));
        }}><option value="">Select active product</option>{products.filter((p) => p.status === "active").map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku}</option>)}</select></label>
        <label>Quantity<input type="number" min="1" step="1" required value={line.quantity} onChange={(e) => setLines((current) => current.map((row, n) => n === i ? { ...row, quantity: e.target.value } : row))} /></label>
        <label>Unit price (ZMW)<input inputMode="decimal" placeholder="e.g. 125.50" required value={line.unitPriceZmw} onChange={(e) => setLines((current) => current.map((row, n) => n === i ? { ...row, unitPriceZmw: e.target.value } : row))} /></label>
        {lines.length > 1 && <button type="button" className="button button-secondary" onClick={() => setLines((current) => current.filter((_, n) => n !== i))}>Remove line</button>}
      </div>)}
      <button type="button" className="button button-secondary" onClick={() => setLines((current) => [...current, blankLine()])}>Add product</button>
      <label className="field-full">Notes<textarea name="notes" rows={2} maxLength={5000} defaultValue={editing?.notes ?? ""} /></label>
      <div><button className="button button-primary">{editing ? "Save changes" : "Save quote"}</button>{editing && <button type="button" className="button button-secondary" onClick={clearForm}>Cancel edit</button>}</div>
      <p className="report-footnote">The quote is saved in ZMW. Marking it sent does not send an email. Converting an accepted quote creates a draft order; stock is reserved only when you confirm that order.</p>
    </form>
    <div className="panel data-table-wrap"><table><thead><tr><th>Quote</th><th>Customer</th><th>Items</th><th>Total</th><th>Valid until</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      {quotes.map((quote) => <tr key={quote.id}><td>{quote.quoteNumber}</td><td>{quote.customerName}</td><td>{quote.lines.map((line) => `${line.productName} × ${line.quantity}`).join(", ")}</td><td>{money(quote.totalZmw)}</td><td>{quote.validUntil || "—"}</td><td>{quote.status}</td><td>
        {(quote.status === "draft" || quote.status === "sent") && <button className="button button-secondary button-small" onClick={() => editQuote(quote)}>Edit</button>}
        {quote.status === "accepted" && <button className="button button-primary button-small" onClick={() => convert(quote)}>Convert to order</button>}
        {quote.status !== "converted" && <button className="button button-danger button-small" onClick={() => removeQuote(quote)}>Delete</button>}
        {quote.status === "converted" && <span>{quote.salesOrderNumber || "Order created"}</span>}
        <button className="button button-secondary button-small" onClick={() => setPrintQuote(quote)}>Print / Save PDF</button>
      </td></tr>)}
    </tbody></table>{!quotes.length && <p className="report-footnote">No customer quotes yet.</p>}</div>
    {printQuote && <div className="quote-preview-overlay" role="dialog" aria-modal="true" aria-labelledby="quote-preview-title">
      <div className="quote-preview-panel">
        <div className="quote-preview-toolbar">
          <div><strong id="quote-preview-title">Customer quote preview</strong><span>Choose “Save as PDF” in the print window.</span></div>
          <div><button className="button button-primary" onClick={() => window.print()}>Print / Save PDF</button><button className="button button-secondary" onClick={() => setPrintQuote(null)}>Close</button></div>
        </div>
        <article className="customer-quote-document" id="customer-quote-print">
          <header className="customer-quote-document-header">
            <div className="customer-quote-document-brand">
              <img src={companyLogo} alt={`${companyName} logo`} />
              <div><strong>{companyName}</strong><small>{companyAddress}<br />{companyEmail}<br />{companyPhone}</small></div>
            </div>
            <div className="customer-quote-document-title">
              <div><span className="customer-quote-document-kicker">CUSTOMER QUOTATION</span><h1>{printQuote.quoteNumber}</h1></div>
              <div className="customer-quote-document-meta">
                <div><span>Quote date</span><strong>{quoteDate(printQuote.createdAt)}</strong></div>
                <div><span>Status</span><strong className="customer-quote-status">{quoteStatusLabel(printQuote.status)}</strong></div>
                <div>
                  <span>Valid until</span>
                  <strong>{printQuote.validUntil ? quoteDate(printQuote.validUntil) : "No expiry date"}</strong>
                  {isQuoteExpired(printQuote) && <em className="customer-quote-expired">Expired</em>}
                </div>
              </div>
            </div>
          </header>
          <section className="customer-quote-document-customer">
            <span>PREPARED FOR</span><strong>{printQuote.customerName}</strong>
            {printQuote.deliveryAddress && <p>{printQuote.deliveryAddress}</p>}
          </section>
          <table className="customer-quote-document-table">
            <thead><tr><th>Product</th><th>SKU</th><th className="quote-number-cell">Qty</th><th className="quote-number-cell">Unit price</th><th className="quote-number-cell">Amount</th></tr></thead>
            <tbody>{printQuote.lines.map((line) => <tr key={line.id}>
              <td>{line.productName}</td><td>{line.sku}</td><td className="quote-number-cell">{line.quantity}</td><td className="quote-number-cell">{money(line.unitPriceZmw)}</td><td className="quote-number-cell">{money(line.lineTotalZmw)}</td>
            </tr>)}</tbody>
          </table>
          <div className="customer-quote-document-total"><span>Total (ZMW)</span><strong>{money(printQuote.totalZmw)}</strong></div>
          {printQuote.notes && <section className="customer-quote-document-notes"><span>NOTES</span><p>{printQuote.notes}</p></section>}
          <section className="customer-quote-document-acceptance"><strong>Customer approval</strong><div><span>Name and signature</span><span>Date</span></div></section>
          <footer className="customer-quote-document-footer">All prices are in ZMW. Quote reference: {printQuote.quoteNumber}</footer>
        </article>
      </div>
    </div>}
  </section>;
}
