import { useEffect, useState, type FormEvent } from "react";
import {
  createSalesOrder, fetchCustomers, fetchMarketingCampaigns, fetchProducts, fetchSalesOrders, saveCustomer, setSalesOrderAttribution, updateSalesOrderStatus,
  type Customer, type MarketingCampaignOption, type Product, type SalesOrder,
} from "../lib/api";

type Mode = "customers" | "orders";
type Line = { productId: string; quantity: string; unitPriceZmw: string };
const emptyLine = (): Line => ({ productId: "", quantity: "1", unitPriceZmw: "" });
const zmw = (amount: string) => `ZMW ${Number(amount).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  async function run(action: () => Promise<void>) {
    setError(""); setNotice("");
    try { await action(); setNotice("Order updated."); setReload((n) => n + 1); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not update this order."); }
  }
  const title = mode === "customers" ? "Customers" : "Sales orders";
  return <section className="supplier-workspace">
    <header className="page-heading"><div><p className="eyebrow">Sales · private records</p><h1>{title}</h1><p>{mode === "customers" ? "Keep customer contact and delivery details in the owner workspace." : "Draft orders, reserve available inventory on confirmation, and record stock leaving when fulfilled."}</p></div></header>
    {error && <div className="notice-strip" role="alert">{error}</div>}{notice && <div className="notice-strip" role="status">{notice}</div>}
    {mode === "customers" && <>
      <form key={editingCustomer?.id ?? "new-customer"} className="panel form-grid" onSubmit={(e) => submit(e, async (d) => saveCustomer({
        name: String(d.get("name")), email: String(d.get("email") || "") || null, phone: String(d.get("phone") || "") || null,
        address: String(d.get("address") || "") || null, notes: String(d.get("notes") || "") || null,
        status: String(d.get("status") || "active") as "active" | "inactive",
      }, editingCustomer?.id))}>
        <h2>{editingCustomer ? "Edit customer" : "Add customer"}</h2><label>Name<input name="name" required maxLength={160} defaultValue={editingCustomer?.name ?? ""} /></label><label>Email<input name="email" type="email" defaultValue={editingCustomer?.email ?? ""} /></label>
        <label>Phone<input name="phone" defaultValue={editingCustomer?.phone ?? ""} /></label><label>Delivery address<input name="address" defaultValue={editingCustomer?.address ?? ""} /></label><label>Notes<input name="notes" defaultValue={editingCustomer?.notes ?? ""} /></label>
        <label>Status<select name="status" defaultValue={editingCustomer?.status ?? "active"}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        <button className="button button-primary">{editingCustomer ? "Save changes" : "Save customer"}</button>{editingCustomer && <button type="button" onClick={() => setEditingCustomer(null)}>Cancel edit</button>}
      </form>
      <div className="panel data-table-wrap"><table><thead><tr><th>Customer</th><th>Contact</th><th>Address</th><th>Status</th><th /></tr></thead><tbody>{customers.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.email || "—"}<br />{c.phone || ""}</td><td>{c.address || "—"}</td><td>{c.status}</td><td><button onClick={() => setEditingCustomer(c)}>Edit details</button></td></tr>)}</tbody></table></div>
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
       <div className="panel data-table-wrap"><table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Campaign source</th><th>Status</th><th>Actions</th></tr></thead><tbody>{orders.map((o) => <tr key={o.id}><td>{o.orderNumber}</td><td>{o.customerName}</td><td>{o.lines.map((l) => `${l.productName} × ${l.quantity}`).join(", ")}</td><td>{zmw(o.totalZmw)}</td><td><select aria-label={`Campaign for ${o.orderNumber}`} value={o.campaignId ?? ""} onChange={(e) => run(() => setSalesOrderAttribution(o.id, e.target.value ? Number(e.target.value) : null))}><option value="">Unattributed</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td><td>{o.status}</td><td>{o.status === "draft" && <><button onClick={() => run(() => updateSalesOrderStatus(o.id, "confirm"))}>Confirm & reserve</button> <button onClick={() => run(() => updateSalesOrderStatus(o.id, "cancel"))}>Cancel</button></>}{o.status === "confirmed" && <><button onClick={() => run(() => updateSalesOrderStatus(o.id, "fulfill"))}>Fulfill</button> <button onClick={() => run(() => updateSalesOrderStatus(o.id, "cancel"))}>Cancel</button></>}</td></tr>)}</tbody></table></div>
    </>}
  </section>;
}
