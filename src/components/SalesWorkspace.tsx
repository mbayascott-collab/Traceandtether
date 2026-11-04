import { useEffect, useState, type FormEvent } from "react";
import companyLogo from "../../attached_assets/google_profile_1793771922305.png";
import {
  createSalesOrder, deleteSalesOrder, fetchCustomers, fetchMarketingCampaigns, fetchProducts, fetchSalesOrders, saveCustomer, setSalesOrderAttribution, updateSalesOrderStatus,
  type Customer, type MarketingCampaignOption, type Product, type SalesOrder,
} from "../lib/api";

type Mode = "customers" | "orders";
type Line = { productId: string; quantity: string; unitPriceZmw: string };
const emptyLine = (): Line => ({ productId: "", quantity: "1", unitPriceZmw: "" });
const zmw = (amount: string) => `ZMW ${Number(amount).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const companyName = "Trace and Tether Craft Studio Limited";
const companyAddress = "164 Mpundu Street, Chelston Extension, Lusaka, Zambia";
const companyEmail = "traceandtether@gmail.com";
const companyPhone = "+260-0977-101-967";
export default function SalesWorkspace({ mode }: { mode: Mode }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [campaigns, setCampaigns] = useState<MarketingCampaignOption[]>([]);
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [orderActionErrors, setOrderActionErrors] = useState<Record<number, string>>({});
  const [busyOrderId, setBusyOrderId] = useState<number | null>(null);
  const [invoiceOrder, setInvoiceOrder] = useState<SalesOrder | null>(null);
  const [deliveryOrder, setDeliveryOrder] = useState<SalesOrder | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([fetchCustomers(), fetchSalesOrders(), fetchProducts({ page: 1, pageSize: 100 }), fetchMarketingCampaigns()])
      .then(([c, o, p, m]) => { if (alive) { setCustomers(c); setOrders(o); setProducts(p.products); setCampaigns(m); } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : "Could not load sales records."); });
    return () => { alive = false; };
  }, [reload]);
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
  function removeOrder(order: SalesOrder) {
    const quoteNote = order.notes?.match(/Created from (CQ-\d{4}-[A-Z0-9]+)/)?.[1];
    const detail = quoteNote ? ` The source quote ${quoteNote} will become accepted again.` : "";
    const orderType = order.status === "cancelled" ? "cancelled order" : "draft order";
    if (!window.confirm(`Delete ${orderType} ${order.orderNumber}? This cannot be undone.${detail}`)) return;
    void run(() => deleteSalesOrder(order.id), "Order deleted.");
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
  const title = mode === "customers" ? "Customers" : "Sales orders";
  return <section className="supplier-workspace">
    <header className="page-heading"><div><p className="eyebrow">Sales · private records</p><h1>{title}</h1><p>{mode === "customers" ? "Keep customer contact and delivery details in the owner workspace." : "Draft orders, reserve available inventory on confirmation, and record stock leaving when fulfilled."}</p></div></header>
    {error && <div className="notice-strip" role="alert">{error}</div>}{notice && <div className="notice-strip" role="status">{notice}</div>}
    {mode === "customers" && <>
      <form key={editingCustomer?.id ?? "new-customer"} className="panel form-grid" onSubmit={(e) => submit(e, async (d) => saveCustomer({
        name: String(d.get("name")), contactPerson: String(d.get("contactPerson") || "") || null,
        contactPersonPhone: String(d.get("contactPersonPhone") || "") || null,
        email: String(d.get("email") || "") || null, phone: String(d.get("phone") || "") || null,
        address: String(d.get("address") || "") || null, notes: String(d.get("notes") || "") || null,
        status: String(d.get("status") || "active") as "active" | "inactive",
      }, editingCustomer?.id))}>
        <h2>{editingCustomer ? "Edit customer" : "Add customer"}</h2><label>Name<input name="name" required maxLength={160} defaultValue={editingCustomer?.name ?? ""} /></label>
        <label>Contact person<input name="contactPerson" maxLength={120} defaultValue={editingCustomer?.contactPerson ?? ""} /></label>
        <label>Contact person's phone<input name="contactPersonPhone" maxLength={60} defaultValue={editingCustomer?.contactPersonPhone ?? ""} /></label>
        <label>Email<input name="email" type="email" defaultValue={editingCustomer?.email ?? ""} /></label>
        <label>Phone<input name="phone" defaultValue={editingCustomer?.phone ?? ""} /></label><label>Delivery address<input name="address" defaultValue={editingCustomer?.address ?? ""} /></label><label>Notes<input name="notes" defaultValue={editingCustomer?.notes ?? ""} /></label>
        <label>Status<select name="status" defaultValue={editingCustomer?.status ?? "active"}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        <button className="button button-primary">{editingCustomer ? "Save changes" : "Save customer"}</button>{editingCustomer && <button type="button" onClick={() => setEditingCustomer(null)}>Cancel edit</button>}
      </form>
      <div className="panel data-table-wrap"><table><thead><tr><th>Customer</th><th>Contact person</th><th>Contact person's phone</th><th>Customer contact details</th><th>Address</th><th>Status</th><th /></tr></thead><tbody>{customers.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.contactPerson || "—"}</td><td>{c.contactPersonPhone || "—"}</td><td>{c.email || "—"}<br />{c.phone || ""}</td><td>{c.address || "—"}</td><td>{c.status}</td><td><button onClick={() => setEditingCustomer(c)}>Edit details</button></td></tr>)}</tbody></table></div>
    </>}
    {mode === "orders" && <>
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
        <div className="panel data-table-wrap"><table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Campaign source</th><th>Status</th><th>Actions</th></tr></thead><tbody>{orders.map((o) => <tr key={o.id}><td>{o.orderNumber}</td><td>{o.customerName}</td><td>{o.lines.map((l) => `${l.productName} × ${l.quantity}`).join(", ")}</td><td>{zmw(o.totalZmw)}</td><td><select aria-label={`Campaign for ${o.orderNumber}`} value={o.campaignId ?? ""} onChange={(e) => run(() => setSalesOrderAttribution(o.id, e.target.value ? Number(e.target.value) : null))}><option value="">Unattributed</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td><td>{o.status}</td><td>
          {o.status === "draft" && <><button disabled={busyOrderId === o.id} onClick={() => run(() => updateSalesOrderStatus(o.id, "confirm"), "Order confirmed; stock reserved.", o.id)}>{busyOrderId === o.id ? "Confirming…" : "Confirm & reserve"}</button> <button disabled={busyOrderId === o.id} onClick={() => run(() => updateSalesOrderStatus(o.id, "cancel"), "Order cancelled.", o.id)}>Cancel</button> <button className="button button-danger button-small" onClick={() => removeOrder(o)}>Delete</button></>}
          {o.status === "cancelled" && !o.confirmedAt && <button className="button button-danger button-small" onClick={() => removeOrder(o)}>Delete</button>}
          {o.status === "confirmed" && <><button className="button button-secondary button-small" onClick={() => setDeliveryOrder(o)}>Delivery note</button> <button onClick={() => run(() => updateSalesOrderStatus(o.id, "fulfill"), "Sale recorded and stock updated.", o.id)}>{busyOrderId === o.id ? "Updating…" : "Fulfill"}</button> <button onClick={() => run(() => updateSalesOrderStatus(o.id, "cancel"), "Order cancelled.", o.id)}>Cancel</button></>}
           {o.status === "fulfilled" && <><button className="button button-secondary button-small" onClick={() => setDeliveryOrder(o)}>Delivery note</button> <button className="button button-secondary button-small" onClick={() => setInvoiceOrder(o)}>Invoice / PDF</button></>}
          {orderActionErrors[o.id] && <small className="order-action-error" role="alert">{orderActionErrors[o.id]}</small>}
        </td></tr>)}</tbody></table></div>
    </>}
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
    {mode === "orders" && deliveryOrder && (() => {
      const customer = customers.find((item) => item.id === deliveryOrder.customerId);
      const noteRef = deliveryNoteNumber(deliveryOrder);
      return <div className="quote-preview-overlay" role="dialog" aria-modal="true" aria-labelledby="delivery-note-preview-title">
        <div className="quote-preview-panel">
          <div className="quote-preview-toolbar">
            <div><strong id="delivery-note-preview-title">Delivery note preview</strong><span>Print this note or save it as a PDF.</span></div>
            <div><button className="button button-primary" onClick={() => window.print()}>Print / Save PDF</button><button className="button button-secondary" onClick={() => setDeliveryOrder(null)}>Close</button></div>
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
                  <div><span>Note date</span><strong>{documentDate(new Date().toISOString())}</strong></div>
                  <div><span>Sales order</span><strong>{deliveryOrder.orderNumber}</strong></div>
                </div>
              </div>
            </header>
            <section className="customer-quote-document-customer">
              <span>DELIVER TO</span><strong>{deliveryOrder.customerName}</strong>
              {customer?.contactPerson && <p>Attn: {customer.contactPerson}</p>}
              {customer?.contactPersonPhone && <p>{customer.contactPersonPhone}</p>}
              {(deliveryOrder.deliveryAddress || customer?.address) && <p>{deliveryOrder.deliveryAddress || customer?.address}</p>}
            </section>
            <table className="customer-quote-document-table">
              <thead><tr><th>Product</th><th>SKU</th><th className="quote-number-cell">Quantity</th></tr></thead>
              <tbody>{deliveryOrder.lines.map((line) => <tr key={line.id}>
                <td>{line.productName}</td><td>{line.sku}</td><td className="quote-number-cell">{line.quantity}</td>
              </tr>)}</tbody>
            </table>
            {deliveryOrder.notes && <section className="customer-quote-document-notes"><span>ORDER NOTES</span><p>{deliveryOrder.notes}</p></section>}
            <section className="delivery-note-signatures" aria-label="Delivery confirmation">
              <div><span>Delivered by</span><span>Name and signature</span><span>Date</span></div>
              <div><span>Received by</span><span>Name and signature</span><span>Date</span></div>
            </section>
            <footer className="customer-quote-document-footer">Please check the items and quantities above when receiving this delivery. This note does not serve as an invoice or payment receipt.</footer>
          </article>
        </div>
      </div>;
    })()}
  </section>;
}
