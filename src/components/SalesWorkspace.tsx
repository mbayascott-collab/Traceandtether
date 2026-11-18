import { useEffect, useState, type FormEvent } from "react";
import companyLogo from "../../attached_assets/google_profile_1793771922305.png";
import {
  createSalesDelivery, createSalesOrder, deleteSalesOrder, fetchCustomers, fetchMarketingCampaigns, fetchProducts, fetchPublicShopOrderAttemptSummary, fetchSalesOrders, saveCustomer, saveSalesDeliveryReceipt, salesDeliveryReceiptProofUrl, setSalesOrderAttribution, updateSalesOrderStatus,
  type Customer, type MarketingCampaignOption, type Product, type SalesDelivery, type SalesOrder,
} from "../lib/api";

type Mode = "customers" | "orders";
type Line = { productId: string; quantity: string; unitPriceZmw: string };
const emptyLine = (): Line => ({ productId: "", quantity: "1", unitPriceZmw: "" });
const zmw = (amount: string) => `ZMW ${Number(amount).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const companyName = "Trace and Tether Craft Studio Limited";
const companyAddress = "164 Mpundu Street, Chelston Extension, Lusaka, Zambia";
const companyEmail = "traceandtether@gmail.com";
const companyPhone = "+260-0977-101-967";
function suggestedStockLocation(line: SalesOrder["lines"][number]) {
  return [...line.stockLocations]
    .filter((location) => location.available >= line.quantity)
    .sort((left, right) => {
      const mainPriority = Number(right.name.toLowerCase() === "main") - Number(left.name.toLowerCase() === "main");
      return mainPriority || left.name.localeCompare(right.name);
    })[0] ?? null;
}
export default function SalesWorkspace({ mode }: { mode: Mode }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [campaigns, setCampaigns] = useState<MarketingCampaignOption[]>([]);
  const [shopAttemptSummary, setShopAttemptSummary] = useState<{ accepted: number; blocked: number } | null>(null);
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [historyCustomer, setHistoryCustomer] = useState<Customer | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [orderActionErrors, setOrderActionErrors] = useState<Record<number, string>>({});
  const [busyOrderId, setBusyOrderId] = useState<number | null>(null);
  const [stockLocationChoices, setStockLocationChoices] = useState<Record<string, number | "auto">>({});
  const [invoiceOrder, setInvoiceOrder] = useState<SalesOrder | null>(null);
  const [deliveryFormOrder, setDeliveryFormOrder] = useState<SalesOrder | null>(null);
  const [deliveryRequestKey, setDeliveryRequestKey] = useState("");
  const [deliverySubmitting, setDeliverySubmitting] = useState(false);
  const [deliveryPrint, setDeliveryPrint] = useState<{ order: SalesOrder; delivery: SalesDelivery | null } | null>(null);
  const [receiptDelivery, setReceiptDelivery] = useState<{ order: SalesOrder; delivery: SalesDelivery } | null>(null);
  const [receiptSubmitting, setReceiptSubmitting] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.all([
      fetchCustomers(), fetchSalesOrders(), fetchProducts({ page: 1, pageSize: 100 }), fetchMarketingCampaigns(),
      mode === "orders" ? fetchPublicShopOrderAttemptSummary() : Promise.resolve(null),
    ])
      .then(([c, o, p, m, summary]) => { if (alive) { setCustomers(c); setOrders(o); setProducts(p.products); setCampaigns(m); setShopAttemptSummary(summary); } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : "Could not load sales records."); });
    return () => { alive = false; };
  }, [reload, mode]);
  async function submit(event: FormEvent<HTMLFormElement>, action: (data: FormData) => Promise<void>) {
    event.preventDefault(); const form = event.currentTarget; setError(""); setNotice("");
    try { await action(new FormData(form)); form.reset(); setLines([emptyLine()]); setEditingCustomer(null); setNotice("Saved."); setReload((n) => n + 1); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save this record."); }
  }
  async function run(action: () => Promise<void>, successMessage = "Order updated.", orderId?: number) {
    setError(""); setNotice("");
    if (orderId) {
      setBusyOrderId(orderId);
      setOrderActionErrors((current) => ({ ...current, [orderId]: "" }));
    }
    try { await action(); setNotice(successMessage); setReload((n) => n + 1); }
    catch (e) {
      const message = e instanceof Error ? e.message : "Could not update this order.";
      setError(message);
      if (orderId) setOrderActionErrors((current) => ({ ...current, [orderId]: message }));
    } finally {
      if (orderId) setBusyOrderId((current) => current === orderId ? null : current);
    }
  }
  async function submitDelivery(event: FormEvent<HTMLFormElement>, order: SalesOrder) {
    event.preventDefault();
    if (deliverySubmitting) return;
    const form = new FormData(event.currentTarget);
    const lines = order.lines.map((line) => ({
      salesOrderLineId: line.id,
      quantity: Number(form.get(`quantity-${line.id}`) || 0),
    })).filter((line) => line.quantity > 0);
    if (!lines.length) { setError("Enter a quantity for at least one item."); return; }
    setError(""); setNotice("");
    setDeliverySubmitting(true);
    try {
      await createSalesDelivery(order.id, {
        idempotencyKey: String(form.get("idempotencyKey")),
        deliveryDate: String(form.get("deliveryDate")),
        lines,
      });
      setDeliveryFormOrder(null);
      setNotice("Delivery recorded. Stock and the customer balance have been updated.");
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record this delivery.");
    } finally {
      setDeliverySubmitting(false);
    }
  }
  async function submitReceipt(event: FormEvent<HTMLFormElement>, delivery: SalesDelivery) {
    event.preventDefault();
    if (receiptSubmitting) return;
    const form = new FormData(event.currentTarget);
    const file = form.get("proofFile");
    if (file instanceof File && file.size > 5 * 1024 * 1024) {
      setError("The signed proof must be 5 MB or smaller.");
      return;
    }
    const receivedAtValue = String(form.get("receivedAt") || "");
    const receivedAt = new Date(receivedAtValue);
    if (!Number.isFinite(receivedAt.getTime())) {
      setError("Enter a valid date and time the delivery was received.");
      return;
    }
    setError(""); setNotice(""); setReceiptSubmitting(true);
    try {
      await saveSalesDeliveryReceipt(delivery.id, {
        receivedBy: String(form.get("receivedBy") || "").trim(),
        receivedAt: receivedAt.toISOString(),
        file: file instanceof File && file.size ? file : null,
      });
      setReceiptDelivery(null);
      setNotice("Delivery receipt saved.");
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the delivery receipt.");
    } finally {
      setReceiptSubmitting(false);
    }
  }
  function localDateTime(value?: string | null) {
    const date = value ? new Date(value) : new Date();
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }
  function removeOrder(order: SalesOrder) {
    const quoteNote = order.notes?.match(/Created from (CQ-\d{4}-[A-Z0-9]+)/)?.[1];
    const detail = quoteNote ? ` The source quote ${quoteNote} will become accepted again.` : "";
    const orderType = order.status === "cancelled" ? "cancelled order" : "draft order";
    if (!window.confirm(`Delete ${orderType} ${order.orderNumber}? This cannot be undone.${detail}`)) return;
    void run(() => deleteSalesOrder(order.id), "Order deleted.");
  }
  function confirmOrder(order: SalesOrder) {
    const locations = order.lines.map((line) => {
      const choice = stockLocationChoices[`${order.id}:${line.productId}`] ?? "auto";
      return { productId: line.productId, locationId: choice === "auto" ? null : choice };
    });
    void run(() => updateSalesOrderStatus(order.id, "confirm", locations), "Order confirmed; stock reserved.", order.id);
  }
  function documentDate(value: string) {
    return new Date(value).toLocaleDateString("en-ZM", { day: "numeric", month: "long", year: "numeric" });
  }
  function invoiceNumber(order: SalesOrder) {
    return `INV-${order.orderNumber.replace(/^SO-/, "")}`;
  }
  function deliveryNoteNumber(order: SalesOrder) {
    return `DN-${order.orderNumber.replace(/^SO-/, "")}`;
  }
  function customerCode(id: number) {
    return `CUS-${String(id).padStart(5, "0")}`;
  }
  function matchesCustomer(customer: Customer, query: string) {
    const value = query.trim().toLowerCase();
    return !value || customer.name.toLowerCase().includes(value) || customerCode(customer.id).toLowerCase().includes(value);
  }
  const filteredCustomers = customers.filter((customer) => matchesCustomer(customer, customerSearch));
  const title = mode === "customers" ? "Customers" : "Sales orders";
  return <section className="supplier-workspace">
    <header className="page-heading"><div><p className="eyebrow">Sales · private records</p><h1>{title}</h1><p>{mode === "customers" ? "Keep customer contact and delivery details in the owner workspace." : "Draft orders, reserve available inventory on confirmation, and record stock leaving with each delivery."}</p></div></header>
    {error && <div className="notice-strip" role="alert">{error}</div>}{notice && <div className="notice-strip" role="status">{notice}</div>}
    {mode === "customers" && <>
      <form key={editingCustomer?.id ?? "new-customer"} className="panel form-grid" onSubmit={(e) => submit(e, async (d) => saveCustomer({
        name: String(d.get("name")), contactPerson: String(d.get("contactPerson") || "") || null,
        contactPersonPhone: String(d.get("contactPersonPhone") || "") || null,
        email: String(d.get("email") || "") || null, phone: String(d.get("phone") || "") || null,
        address: String(d.get("address") || "") || null,
        paymentTermDays: String(d.get("paymentTermDays") ?? "") === "" ? null : Number(d.get("paymentTermDays")),
        notes: String(d.get("notes") || "") || null,
        status: String(d.get("status") || "active") as "active" | "inactive",
      }, editingCustomer?.id))}>
        <h2>{editingCustomer ? "Edit customer" : "Add customer"}</h2><label>Name<input name="name" required maxLength={160} defaultValue={editingCustomer?.name ?? ""} /></label>
        <label>Contact person<input name="contactPerson" maxLength={120} defaultValue={editingCustomer?.contactPerson ?? ""} /></label>
        <label>Contact person's phone<input name="contactPersonPhone" maxLength={60} defaultValue={editingCustomer?.contactPersonPhone ?? ""} /></label>
        <label>Email<input name="email" type="email" defaultValue={editingCustomer?.email ?? ""} /></label>
        <label>Phone<input name="phone" defaultValue={editingCustomer?.phone ?? ""} /></label><label>Delivery address<input name="address" defaultValue={editingCustomer?.address ?? ""} /></label><label>Notes<input name="notes" defaultValue={editingCustomer?.notes ?? ""} /></label>
        <label>Payment terms (days)<input name="paymentTermDays" type="number" min="0" max="1000000" step="1" defaultValue={editingCustomer?.paymentTermDays ?? ""} /><span className="field-hint">Counted from the latest delivery. Leave blank when no day-based term is set.</span></label>
        <label>Status<select name="status" defaultValue={editingCustomer?.status ?? "active"}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        <button className="button button-primary">{editingCustomer ? "Save changes" : "Save customer"}</button>{editingCustomer && <button type="button" onClick={() => setEditingCustomer(null)}>Cancel edit</button>}
      </form>
      <label>Search customers by name or ID<input type="search" placeholder="Name or ID, such as CUS-00001" value={customerSearch} onChange={(event) => {
        const value = event.target.value;
        setCustomerSearch(value);
        if (historyCustomer && !matchesCustomer(historyCustomer, value)) setHistoryCustomer(null);
      }} /></label>
      <div className="panel data-table-wrap"><table><thead><tr><th>Customer</th><th>Customer ID</th><th /></tr></thead><tbody>{filteredCustomers.map((c) => <tr key={c.id}><td>{c.name}</td><td>{customerCode(c.id)}</td><td><button className="button button-secondary button-small" onClick={() => setHistoryCustomer(historyCustomer?.id === c.id ? null : c)}>{historyCustomer?.id === c.id ? "Close customer" : "View customer"}</button></td></tr>)}</tbody></table>{!filteredCustomers.length && <p className="report-footnote">No customers match that name or ID.</p>}</div>
      {historyCustomer && filteredCustomers.some((item) => item.id === historyCustomer.id) && (() => {
        const customer = customers.find((item) => item.id === historyCustomer.id) ?? historyCustomer;
        const purchases = orders
          .filter((order) => order.customerId === customer.id && Number(order.deliveredZmw) > 0)
          .sort((a, b) => b.orderDate.localeCompare(a.orderDate));
        return <div className="panel data-table-wrap">
          <div className="panel-heading"><div><p className="eyebrow">Customer account</p><h2>{customer.name}</h2><p>Customer ID: <strong>{customerCode(customer.id)}</strong></p></div><div><button className="button button-secondary button-small" onClick={() => setEditingCustomer(customer)}>Edit details</button>{" "}<button className="button button-secondary button-small" onClick={() => setHistoryCustomer(null)}>Close customer</button></div></div>
          <p><strong>Contact person:</strong> {customer.contactPerson || "—"}</p>
          <p><strong>Contact person's phone:</strong> {customer.contactPersonPhone || "—"}</p>
          <p><strong>Email:</strong> {customer.email || "—"}</p>
          <p><strong>Phone:</strong> {customer.phone || "—"}</p>
          <p><strong>Address:</strong> {customer.address || "—"}</p>
          <p><strong>Status:</strong> {customer.status}</p>
          {customer.notes && <p><strong>Notes:</strong> {customer.notes}</p>}
          <h3>Past purchases</h3><p className="report-footnote">Only items already delivered are counted as purchases.</p>
          <table><thead><tr><th>Order</th><th>Order date</th><th>Items delivered</th><th>Delivered value</th><th>Status</th></tr></thead>
            <tbody>{purchases.map((order) => <tr key={order.id}>
              <td>{order.orderNumber}</td><td>{new Date(order.orderDate).toLocaleDateString("en-ZM")}</td>
              <td>{order.lines.filter((line) => line.deliveredQuantity > 0).map((line) => `${line.productName} × ${line.deliveredQuantity}`).join(", ")}</td>
              <td>{zmw(order.deliveredZmw)}</td><td>{order.status.replace("_", " ")}</td>
            </tr>)}</tbody>
          </table>
          {!purchases.length && <p className="report-footnote">This customer has no delivered purchases yet.</p>}
        </div>;
      })()}
    </>}
    {mode === "orders" && <>
      <section className="panel" aria-labelledby="public-shop-attempts-heading">
        <div className="panel-heading"><div><h2 id="public-shop-attempts-heading">Public shop order requests</h2><p>Lifetime totals. Blocked counts include requests stopped by the shop’s anti-abuse checks.</p></div></div>
        <div className="metric-grid">
          <article className="metric-card"><div className="metric-top"><span>Accepted requests</span></div><strong className="metric-value">{shopAttemptSummary?.accepted ?? "—"}</strong></article>
          <article className="metric-card"><div className="metric-top"><span>Blocked requests</span></div><strong className="metric-value">{shopAttemptSummary?.blocked ?? "—"}</strong></article>
        </div>
        <p className="report-footnote">Only totals are saved. Rejected visitors’ contact details are not collected for this summary.</p>
      </section>
      <form className="panel form-grid" onSubmit={(e) => submit(e, async (d) => createSalesOrder({
        customerId: Number(d.get("customerId")), deliveryAddress: String(d.get("deliveryAddress") || "") || null, notes: String(d.get("notes") || "") || null,
        lines: lines.map((line) => ({ productId: Number(line.productId), quantity: Number(line.quantity), unitPriceZmw: line.unitPriceZmw })),
      }))}>
        <h2>Create draft order</h2><label>Customer<select name="customerId" required defaultValue=""><option value="">Select customer</option>{customers.filter((c) => c.status === "active").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Delivery address<input name="deliveryAddress" /></label>
        {lines.map((line, i) => <div className="form-grid" key={i}>
          <label>Product<select required value={line.productId} onChange={(e) => { const product = products.find((p) => p.id === Number(e.target.value)); setLines((old) => old.map((v, n) => n === i ? { ...v, productId: e.target.value, unitPriceZmw: product?.sellingPriceZmw || "" } : v)); }}><option value="">Select active product</option>{products.filter((p) => p.status === "active").map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku}</option>)}</select></label>
          <label>Quantity<input type="number" min="1" required value={line.quantity} onChange={(e) => setLines((old) => old.map((v, n) => n === i ? { ...v, quantity: e.target.value } : v))} /></label>
          <label>Unit price (ZMW)<input inputMode="decimal" required value={line.unitPriceZmw} onChange={(e) => setLines((old) => old.map((v, n) => n === i ? { ...v, unitPriceZmw: e.target.value } : v))} /></label>
          {lines.length > 1 && <button type="button" onClick={() => setLines((old) => old.filter((_, n) => n !== i))}>Remove line</button>}
        </div>)}
        <button type="button" className="button button-secondary" onClick={() => setLines((old) => [...old, emptyLine()])}>Add product line</button>
        <label>Notes<input name="notes" /></label><button className="button button-primary">Save draft</button>
      </form>
          <div className="panel data-table-wrap"><table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Stock location</th><th>Delivered / total</th><th>Campaign source</th><th>Status</th><th>Actions</th></tr></thead><tbody>{orders.map((o) => <tr key={o.id}><td>{o.orderNumber}</td><td>{o.customerName}</td><td>{o.lines.map((l) => `${l.productName} × ${l.deliveredQuantity}/${l.quantity}`).join(", ")}</td><td>{o.lines.map((line) => {
            const choice = stockLocationChoices[`${o.id}:${line.productId}`] ?? "auto";
            const suggested = suggestedStockLocation(line);
            return <div key={line.id}>
              <strong>{line.productName}: </strong>
              {o.status === "draft" ? <select
                aria-label={`Stock location for ${line.productName} on ${o.orderNumber}`}
                value={choice === "auto" ? "auto" : String(choice)}
                onChange={(event) => setStockLocationChoices((current) => ({
                  ...current,
                  [`${o.id}:${line.productId}`]: event.target.value === "auto" ? "auto" : Number(event.target.value),
                }))}
              >
                <option value="auto">Auto{suggested ? ` · ${suggested.name} (${suggested.available} available)` : " · no location has enough stock"}</option>
                {line.stockLocations.map((location) => <option key={location.id} value={location.id} disabled={location.available < line.quantity}>
                  {location.name} · {location.available} available
                </option>)}
              </select> : <span>{line.stockLocationName || "Not reserved"}</span>}
            </div>;
          })}</td><td>{zmw(o.deliveredZmw)} / {zmw(o.totalZmw)}</td><td><select aria-label={`Campaign for ${o.orderNumber}`} value={o.campaignId ?? ""} onChange={(e) => run(() => setSalesOrderAttribution(o.id, e.target.value ? Number(e.target.value) : null))}><option value="">Unattributed</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td><td>{o.status.replace("_", " ")}</td><td>
          {o.status === "draft" && <><button disabled={busyOrderId === o.id} onClick={() => confirmOrder(o)}>{busyOrderId === o.id ? "Confirming…" : "Confirm & reserve"}</button> <button disabled={busyOrderId === o.id} onClick={() => run(() => updateSalesOrderStatus(o.id, "cancel"), "Order cancelled.", o.id)}>Cancel</button> <button className="button button-danger button-small" onClick={() => removeOrder(o)}>Delete</button></>}
          {o.status === "cancelled" && !o.confirmedAt && <button className="button button-danger button-small" onClick={() => removeOrder(o)}>Delete</button>}
          {(o.status === "confirmed" || o.status === "partially_fulfilled") && <><button className="button button-secondary button-small" onClick={() => { setDeliveryRequestKey(window.crypto.randomUUID()); setDeliveryFormOrder(o); }}>Record delivery</button> <button onClick={() => run(() => updateSalesOrderStatus(o.id, "cancel"), "Remaining order quantities cancelled.", o.id)}>Cancel remaining</button></>}
            {o.deliveries.map((delivery) => <span key={delivery.id} className="delivery-actions">
              <button className="button button-secondary button-small" onClick={() => setDeliveryPrint({ order: o, delivery })}>{delivery.deliveryNumber}</button>
              <button className="button button-secondary button-small" onClick={() => setReceiptDelivery({ order: o, delivery })}>
                {delivery.receipt ? "Edit receipt" : "Record receipt"}
              </button>
            </span>)}
           {o.status === "fulfilled" && <button className="button button-secondary button-small" onClick={() => setInvoiceOrder(o)}>Invoice / PDF</button>}
           {o.status === "fulfilled" && !o.deliveries.length && <button className="button button-secondary button-small" onClick={() => setDeliveryPrint({ order: o, delivery: null })}>Delivery note</button>}
          {orderActionErrors[o.id] && <small className="order-action-error" role="alert">{orderActionErrors[o.id]}</small>}
        </td></tr>)}</tbody></table></div>
    </>}
    {mode === "orders" && deliveryFormOrder && <div className="modal-backdrop" role="presentation">
      <form className="modal form-grid delivery-entry-form" onSubmit={(event) => submitDelivery(event, deliveryFormOrder)}>
        <h2>Record delivery · {deliveryFormOrder.orderNumber}</h2>
        <input type="hidden" name="idempotencyKey" value={deliveryRequestKey} />
        <label>Delivery date<input type="date" name="deliveryDate" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
        {deliveryFormOrder.lines.filter((line) => line.remainingQuantity > 0).map((line) => <label key={line.id}>
          {line.productName} · {line.sku} · {line.remainingQuantity} remaining · Stock location: {line.stockLocationName || "Not recorded"}
          <input type="number" name={`quantity-${line.id}`} min="0" max={line.remainingQuantity} defaultValue="0" />
        </label>)}
        <div className="modal-footer-actions"><button type="button" className="button button-secondary" disabled={deliverySubmitting} onClick={() => setDeliveryFormOrder(null)}>Cancel</button><button className="button button-primary" disabled={deliverySubmitting}>{deliverySubmitting ? "Saving…" : "Save delivery"}</button></div>
      </form>
    </div>}
    {mode === "orders" && receiptDelivery && <div className="modal-backdrop" role="presentation">
      <form className="modal form-grid delivery-entry-form" onSubmit={(event) => submitReceipt(event, receiptDelivery.delivery)}>
        <h2>Delivery receipt · {receiptDelivery.delivery.deliveryNumber}</h2>
        <p>{receiptDelivery.order.customerName} · {receiptDelivery.order.orderNumber}</p>
        <label>Received by<input name="receivedBy" required maxLength={120} defaultValue={receiptDelivery.delivery.receipt?.receivedBy ?? ""} /></label>
        <label>Date and time received<input name="receivedAt" type="datetime-local" required defaultValue={localDateTime(receiptDelivery.delivery.receipt?.receivedAt)} /></label>
        <label>Signed proof (PDF or image, up to 5 MB)
          <input name="proofFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" />
        </label>
        {receiptDelivery.delivery.receipt?.proofFileName && <p>
          Saved proof: <a href={salesDeliveryReceiptProofUrl(receiptDelivery.delivery.id)} target="_blank" rel="noreferrer">
            {receiptDelivery.delivery.receipt.proofFileName}
          </a>. Choosing another file replaces it.
        </p>}
        <p className="report-footnote">Receipt details and signed proof are stored with this delivery note, separately from invoices and payments.</p>
        <div className="modal-footer-actions">
          <button type="button" className="button button-secondary" disabled={receiptSubmitting} onClick={() => setReceiptDelivery(null)}>Cancel</button>
          <button className="button button-primary" disabled={receiptSubmitting}>{receiptSubmitting ? "Saving…" : "Save receipt"}</button>
        </div>
      </form>
    </div>}
    {mode === "orders" && invoiceOrder && (() => {
      const customer = customers.find((item) => item.id === invoiceOrder.customerId);
      const invoiceRef = invoiceNumber(invoiceOrder);
      const date = invoiceOrder.fulfilledAt || invoiceOrder.orderDate;
      return <div className="quote-preview-overlay" role="dialog" aria-modal="true" aria-labelledby="invoice-preview-title">
        <div className="quote-preview-panel">
          <div className="quote-preview-toolbar">
            <div><strong id="invoice-preview-title">Invoice preview</strong><span>Choose “Save as PDF” in the print window.</span></div>
            <div><button className="button button-primary" onClick={() => window.print()}>Print / Save PDF</button><button className="button button-secondary" onClick={() => setInvoiceOrder(null)}>Close</button></div>
          </div>
          <article className="customer-quote-document" id="sales-invoice-print">
            <header className="customer-quote-document-header">
              <div className="customer-quote-document-brand"><img src={companyLogo} alt={`${companyName} logo`} /><div><strong>{companyName}</strong><small>{companyAddress}<br />{companyEmail}<br />{companyPhone}</small></div></div>
              <div className="customer-quote-document-title">
                <div><span className="customer-quote-document-kicker">SALES INVOICE</span><h1>{invoiceRef}</h1></div>
                <div className="customer-quote-document-meta">
                  <div><span>Invoice date</span><strong>{documentDate(date)}</strong></div>
                  <div><span>Sales order</span><strong>{invoiceOrder.orderNumber}</strong></div>
                </div>
              </div>
            </header>
            <section className="customer-quote-document-customer">
              <span>INVOICE FOR</span><strong>{invoiceOrder.customerName}</strong>
              {customer?.email && <p>{customer.email}</p>}
              {customer?.phone && <p>{customer.phone}</p>}
              {customer?.address && <p><b>Billing address:</b> {customer.address}</p>}
              {invoiceOrder.deliveryAddress && <p><b>Delivery address:</b> {invoiceOrder.deliveryAddress}</p>}
            </section>
            <table className="customer-quote-document-table">
              <thead><tr><th>Product</th><th>SKU</th><th className="quote-number-cell">Qty</th><th className="quote-number-cell">Unit price</th><th className="quote-number-cell">Amount</th></tr></thead>
              <tbody>{invoiceOrder.lines.map((line) => <tr key={line.id}>
                <td>{line.productName}</td><td>{line.sku}</td><td className="quote-number-cell">{line.quantity}</td><td className="quote-number-cell">{zmw(line.unitPriceZmw)}</td><td className="quote-number-cell">{zmw(line.lineTotalZmw)}</td>
              </tr>)}</tbody>
            </table>
            <div className="customer-quote-document-total"><span>Total (ZMW)</span><strong>{zmw(invoiceOrder.totalZmw)}</strong></div>
            {invoiceOrder.notes && <section className="customer-quote-document-notes"><span>NOTES</span><p>{invoiceOrder.notes}</p></section>}
            <footer className="customer-quote-document-footer">All prices are in ZMW. Invoice reference: {invoiceRef} · Sales order: {invoiceOrder.orderNumber}</footer>
          </article>
        </div>
      </div>;
    })()}
    {mode === "orders" && deliveryPrint && (() => {
      const { order, delivery } = deliveryPrint;
      const customer = customers.find((item) => item.id === order.customerId);
      const noteRef = delivery?.deliveryNumber ?? deliveryNoteNumber(order);
      const noteLines = delivery
        ? delivery.lines.map((line) => ({ ...line }))
        : order.lines.map((line) => ({ salesOrderLineId: line.id, productName: line.productName, sku: line.sku, quantity: line.quantity }));
      return <div className="quote-preview-overlay" role="dialog" aria-modal="true" aria-labelledby="delivery-note-preview-title">
        <div className="quote-preview-panel">
          <div className="quote-preview-toolbar">
            <div><strong id="delivery-note-preview-title">Delivery note preview</strong><span>Print this note or save it as a PDF.</span></div>
            <div><button className="button button-primary" onClick={() => window.print()}>Print / Save PDF</button><button className="button button-secondary" onClick={() => setDeliveryPrint(null)}>Close</button></div>
          </div>
          <article className="customer-quote-document" id="delivery-note-print">
            <header className="customer-quote-document-header">
              <div className="customer-quote-document-brand">
                <img src={companyLogo} alt={`${companyName} logo`} />
                <div><strong>{companyName}</strong><small>{companyAddress}<br />{companyEmail}<br />{companyPhone}</small></div>
              </div>
              <div className="customer-quote-document-title">
                <div><span className="customer-quote-document-kicker">DELIVERY NOTE</span><h1>{noteRef}</h1></div>
                <div className="customer-quote-document-meta">
                  <div><span>Note date</span><strong>{documentDate(delivery?.deliveryDate ?? order.fulfilledAt ?? order.orderDate)}</strong></div>
                  <div><span>Sales order</span><strong>{order.orderNumber}</strong></div>
                </div>
              </div>
            </header>
            <section className="customer-quote-document-customer">
              <span>DELIVER TO</span><strong>{order.customerName}</strong>
              {customer?.contactPerson && <p>Attn: {customer.contactPerson}</p>}
              {customer?.contactPersonPhone && <p>{customer.contactPersonPhone}</p>}
              {(order.deliveryAddress || customer?.address) && <p>{order.deliveryAddress || customer?.address}</p>}
            </section>
            <table className="customer-quote-document-table">
              <thead><tr><th>Product</th><th>SKU</th><th className="quote-number-cell">Quantity</th></tr></thead>
              <tbody>{noteLines.map((line) => <tr key={line.salesOrderLineId}>
                <td>{line.productName}</td><td>{line.sku}</td><td className="quote-number-cell">{line.quantity}</td>
              </tr>)}</tbody>
            </table>
            {order.notes && <section className="customer-quote-document-notes"><span>ORDER NOTES</span><p>{order.notes}</p></section>}
            <section className="delivery-note-signatures" aria-label="Delivery confirmation">
              <div><span>Delivered by</span><span>Name and signature</span><span>Date</span></div>
              {delivery?.receipt
                ? <div><span>Received by</span><strong>{delivery.receipt.receivedBy}</strong><span>{new Date(delivery.receipt.receivedAt).toLocaleString("en-ZM", { dateStyle: "medium", timeStyle: "short" })}</span></div>
                : <div><span>Received by</span><span>Name and signature</span><span>Date</span></div>}
            </section>
            {delivery?.receipt?.proofFileName && <p className="report-footnote">
              Signed proof saved: <a href={salesDeliveryReceiptProofUrl(delivery.id)} target="_blank" rel="noreferrer">{delivery.receipt.proofFileName}</a>
            </p>}
            <footer className="customer-quote-document-footer">Please check the items and quantities above when receiving this delivery. This note does not serve as an invoice or payment receipt.</footer>
          </article>
        </div>
      </div>;
    })()}
  </section>;
}
