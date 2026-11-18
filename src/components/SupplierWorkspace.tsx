import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertCircle, ArrowLeftRight, Pencil, Plus, RefreshCw, Search, Truck } from "lucide-react";
import {
  ApiError,
  createSupplier,
  createSupplierQuote,
  fetchProducts,
  fetchSupplierQuotes,
  fetchSuppliers,
  updateSupplier,
  updateSupplierQuote,
  type Product,
  type Supplier,
  type SupplierInput,
  type SupplierQuote,
  type SupplierQuoteInput,
  type SupplierStatus,
} from "../lib/api";

type Mode = "suppliers" | "quotes" | "comparison";
type SupplierDraft = {
  name: string; country: string; contactName: string; email: string; phone: string;
  website: string; paymentTerms: string; paymentTermDays: string; defaultLeadTimeDays: string; notes: string;
  status: SupplierStatus;
};
type QuoteDraft = {
  supplierId: string;
  productId: string;
  quoteReference: string;
  supplierProductCode: string;
  unitPrice: string;
  currency: string;
  minimumOrderQuantity: string;
  leadTimeDays: string;
  validUntil: string;
  paymentTerms: string;
  shippingTerms: string;
  notes: string;
  status: SupplierQuoteInput["status"];
};

const emptySupplier = (): SupplierDraft => ({
  name: "", country: "", contactName: "", email: "", phone: "", website: "",
  paymentTerms: "", paymentTermDays: "", defaultLeadTimeDays: "0", notes: "", status: "active",
});
const emptyQuote = (): QuoteDraft => ({
  supplierId: "", productId: "", quoteReference: "", supplierProductCode: "",
  unitPrice: "", currency: "CNY", minimumOrderQuantity: "1", leadTimeDays: "0",
  validUntil: "", paymentTerms: "", shippingTerms: "", notes: "", status: "received",
});
const optional = (value: string) => value.trim() || null;
const messageOf = (error: unknown) => error instanceof ApiError || error instanceof Error
  ? error.message : "Something went wrong. Try again.";

function money(value: string, currency: string) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return `${currency} ${value}`;
  const whole = new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(BigInt(match[1]));
  return `${currency} ${whole}.${(match[2] ?? "").padEnd(2, "0")}`;
}

function comparePrices(a: string, b: string) {
  const minorUnits = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  };
  const left = minorUnits(a);
  const right = minorUnits(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function SupplierModal({ value, onClose, onSaved }: {
  value: Supplier | null;
  onClose: () => void;
  onSaved: (supplier: Supplier) => void;
}) {
  const [draft, setDraft] = useState<SupplierDraft>(() => value ? {
    name: value.name, country: value.country ?? "", contactName: value.contactName ?? "",
    email: value.email ?? "", phone: value.phone ?? "", website: value.website ?? "",
    paymentTerms: value.paymentTerms ?? "", paymentTermDays: value.paymentTermDays === null ? "" : String(value.paymentTermDays),
    defaultLeadTimeDays: String(value.defaultLeadTimeDays),
    notes: value.notes ?? "", status: value.status,
  } : emptySupplier());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (key: keyof SupplierDraft, next: string) => setDraft((current) => ({ ...current, [key]: next }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSaving(true);
    const input: SupplierInput = {
      ...draft,
      name: draft.name.trim(),
      country: optional(draft.country),
      contactName: optional(draft.contactName),
      email: optional(draft.email),
      phone: optional(draft.phone),
      website: optional(draft.website),
      paymentTerms: optional(draft.paymentTerms),
      paymentTermDays: draft.paymentTermDays.trim() === "" ? null : Number(draft.paymentTermDays),
      defaultLeadTimeDays: Number(draft.defaultLeadTimeDays),
      notes: optional(draft.notes),
    };
    try {
      const saved = value ? await updateSupplier(value.id, input) : await createSupplier(input);
      onSaved(saved);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="supplier-modal-title">
        <div className="modal-header">
          <div><p className="eyebrow">Supplier directory</p><h2 id="supplier-modal-title">{value ? "Edit supplier" : "Add supplier"}</h2><p>Internal sourcing record; suppliers do not sign in to this workspace.</p></div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="form-grid">
              <div className="field field-full"><label htmlFor="supplier-name">Supplier name <em>Required</em></label><input id="supplier-name" value={draft.name} onChange={(e) => set("name", e.target.value)} maxLength={160} required autoFocus /></div>
              <div className="field"><label htmlFor="supplier-country">Country</label><input id="supplier-country" value={draft.country} onChange={(e) => set("country", e.target.value)} maxLength={80} /></div>
              <div className="field"><label htmlFor="supplier-contact">Contact person</label><input id="supplier-contact" value={draft.contactName} onChange={(e) => set("contactName", e.target.value)} maxLength={120} /></div>
              <div className="field"><label htmlFor="supplier-email">Email</label><input id="supplier-email" type="email" value={draft.email} onChange={(e) => set("email", e.target.value)} maxLength={254} /></div>
              <div className="field"><label htmlFor="supplier-phone">Phone</label><input id="supplier-phone" value={draft.phone} onChange={(e) => set("phone", e.target.value)} maxLength={60} /></div>
              <div className="field field-full"><label htmlFor="supplier-website">Website</label><input id="supplier-website" type="url" placeholder="https://" value={draft.website} onChange={(e) => set("website", e.target.value)} maxLength={300} /></div>
              <div className="field"><label htmlFor="supplier-lead">Typical lead time (days)</label><input id="supplier-lead" type="number" min="0" max="1000000" step="1" value={draft.defaultLeadTimeDays} onChange={(e) => set("defaultLeadTimeDays", e.target.value)} required /></div>
              <div className="field"><label htmlFor="supplier-terms">Default payment terms</label><input id="supplier-terms" value={draft.paymentTerms} onChange={(e) => set("paymentTerms", e.target.value)} maxLength={300} placeholder="e.g. 30% deposit" /></div>
              <div className="field"><label htmlFor="supplier-terms-days">Payment terms (days)</label><input id="supplier-terms-days" type="number" min="0" max="1000000" step="1" value={draft.paymentTermDays} onChange={(e) => set("paymentTermDays", e.target.value)} /><span className="field-hint">Counted from the purchase order date. Free-text terms are not interpreted.</span></div>
              <div className="field"><label htmlFor="supplier-status">Status</label><select id="supplier-status" value={draft.status} onChange={(e) => set("status", e.target.value as SupplierStatus)}><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
              <div className="field field-full"><label htmlFor="supplier-notes">Internal notes</label><textarea id="supplier-notes" value={draft.notes ?? ""} onChange={(e) => set("notes", e.target.value)} maxLength={5000} /></div>
              {error && <div className="alert alert-error field-full" role="alert"><AlertCircle /><span>{error}</span></div>}
            </div>
          </div>
          <div className="modal-footer"><span className="modal-footer-note">Existing quotations are retained if a supplier is made inactive.</span><div className="modal-footer-actions"><button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? "Saving…" : "Save supplier"}</button></div></div>
        </form>
      </section>
    </div>
  );
}

function QuoteModal({ quote, products, suppliers, onClose, onSaved }: {
  quote: SupplierQuote | null;
  products: Product[];
  suppliers: Supplier[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<QuoteDraft>(() => quote ? {
    supplierId: String(quote.supplierId), productId: String(quote.productId),
    quoteReference: quote.quoteReference ?? "", supplierProductCode: quote.supplierProductCode ?? "",
    unitPrice: quote.unitPrice, currency: quote.currency, minimumOrderQuantity: String(quote.minimumOrderQuantity),
    leadTimeDays: String(quote.leadTimeDays), validUntil: quote.validUntil ?? "",
    paymentTerms: quote.paymentTerms ?? "", shippingTerms: quote.shippingTerms ?? "",
    notes: quote.notes ?? "", status: quote.status,
  } : emptyQuote());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (key: keyof QuoteDraft, next: string) => setDraft((current) => ({ ...current, [key]: next }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSaving(true);
    const input: SupplierQuoteInput = {
      ...draft,
      supplierId: Number(draft.supplierId),
      productId: Number(draft.productId),
      quoteReference: optional(draft.quoteReference),
      supplierProductCode: optional(draft.supplierProductCode),
      unitPrice: draft.unitPrice.trim(),
      currency: draft.currency.trim().toUpperCase(),
      minimumOrderQuantity: Number(draft.minimumOrderQuantity),
      leadTimeDays: Number(draft.leadTimeDays),
      validUntil: optional(draft.validUntil),
      paymentTerms: optional(draft.paymentTerms),
      shippingTerms: optional(draft.shippingTerms),
      notes: optional(draft.notes),
    };
    try {
      if (quote) await updateSupplierQuote(quote.id, input);
      else await createSupplierQuote(input);
      onSaved();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="quote-modal-title">
        <div className="modal-header"><div><p className="eyebrow">Supplier sourcing</p><h2 id="quote-modal-title">{quote ? "Edit quotation" : "Record quotation"}</h2><p>Prices remain in the supplier's quoted currency.</p></div><button className="icon-button" aria-label="Close" onClick={onClose}>×</button></div>
        <form onSubmit={submit}>
          <div className="modal-body"><div className="form-grid">
            <div className="field"><label htmlFor="quote-product">Product <em>Required</em></label><select id="quote-product" value={draft.productId} onChange={(e) => set("productId", e.target.value)} required><option value="">Select product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}</select></div>
            <div className="field"><label htmlFor="quote-supplier">Supplier <em>Required</em></label><select id="quote-supplier" value={draft.supplierId} onChange={(e) => set("supplierId", e.target.value)} required><option value="">Select supplier</option>{suppliers.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
            <div className="field"><label htmlFor="quote-price">Unit price <em>Required</em></label><input id="quote-price" inputMode="decimal" placeholder="e.g. 125.50" value={draft.unitPrice} onChange={(e) => set("unitPrice", e.target.value)} required /></div>
            <div className="field"><label htmlFor="quote-currency">Currency</label><input id="quote-currency" value={draft.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} maxLength={3} minLength={3} required /></div>
            <div className="field"><label htmlFor="quote-moq">Minimum order quantity</label><input id="quote-moq" type="number" min="1" step="1" value={draft.minimumOrderQuantity} onChange={(e) => set("minimumOrderQuantity", e.target.value)} required /></div>
            <div className="field"><label htmlFor="quote-lead">Lead time (days)</label><input id="quote-lead" type="number" min="0" step="1" value={draft.leadTimeDays} onChange={(e) => set("leadTimeDays", e.target.value)} required /></div>
            <div className="field"><label htmlFor="quote-reference">Quote reference</label><input id="quote-reference" value={draft.quoteReference ?? ""} onChange={(e) => set("quoteReference", e.target.value)} maxLength={100} /></div>
            <div className="field"><label htmlFor="quote-code">Supplier product code</label><input id="quote-code" value={draft.supplierProductCode ?? ""} onChange={(e) => set("supplierProductCode", e.target.value)} maxLength={100} /></div>
            <div className="field"><label htmlFor="quote-valid">Valid until</label><input id="quote-valid" type="date" value={draft.validUntil ?? ""} onChange={(e) => set("validUntil", e.target.value)} /></div>
            <div className="field"><label htmlFor="quote-status">Status</label><select id="quote-status" value={draft.status} onChange={(e) => set("status", e.target.value as QuoteDraft["status"])}><option value="received">Received</option><option value="accepted">Accepted</option><option value="rejected">Rejected</option></select></div>
            <div className="field"><label htmlFor="quote-payment">Payment terms</label><input id="quote-payment" value={draft.paymentTerms ?? ""} onChange={(e) => set("paymentTerms", e.target.value)} maxLength={300} /></div>
            <div className="field"><label htmlFor="quote-shipping">Shipping terms</label><input id="quote-shipping" value={draft.shippingTerms ?? ""} onChange={(e) => set("shippingTerms", e.target.value)} maxLength={120} /></div>
            <div className="field field-full"><label htmlFor="quote-notes">Notes</label><textarea id="quote-notes" value={draft.notes ?? ""} onChange={(e) => set("notes", e.target.value)} maxLength={5000} /></div>
            {error && <div className="alert alert-error field-full" role="alert"><AlertCircle /><span>{error}</span></div>}
          </div></div>
          <div className="modal-footer"><span className="modal-footer-note">No currency conversion or landed-cost estimate is applied.</span><div className="modal-footer-actions"><button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? "Saving…" : "Save quotation"}</button></div></div>
        </form>
      </section>
    </div>
  );
}

export default function SupplierWorkspace({ mode }: { mode: Mode }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [quotes, setQuotes] = useState<SupplierQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [productFilter, setProductFilter] = useState("");
  const [reload, setReload] = useState(0);
  const [supplierDialog, setSupplierDialog] = useState<Supplier | "new" | null>(null);
  const [quoteDialog, setQuoteDialog] = useState<SupplierQuote | "new" | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    Promise.all([fetchSuppliers(), fetchProducts({ pageSize: 100 })])
      .then(([supplierRows, productRows]) => {
        if (!alive) return;
        setSuppliers(supplierRows);
        setProducts(productRows.products);
      })
      .catch((cause: unknown) => { if (alive) setError(messageOf(cause)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [reload]);

  useEffect(() => {
    let alive = true;
    if (mode === "suppliers" || (mode === "comparison" && !productFilter)) {
      setQuotes([]);
      return () => { alive = false; };
    }
    const productId = mode === "comparison" && productFilter ? Number(productFilter) : undefined;
    fetchSupplierQuotes(productId)
      .then((rows) => { if (alive) setQuotes(rows); })
      .catch((cause: unknown) => { if (alive) setError(messageOf(cause)); });
    return () => { alive = false; };
  }, [mode, productFilter, reload]);

  const filteredSuppliers = useMemo(() => suppliers.filter((supplier) =>
    `${supplier.name} ${supplier.country ?? ""} ${supplier.contactName ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  ), [suppliers, search]);
  const shownQuotes = useMemo(() => {
    const rows = quotes.filter((quote) => mode !== "comparison" || String(quote.productId) === productFilter);
    return [...rows].sort((a, b) => a.currency.localeCompare(b.currency) || comparePrices(a.unitPrice, b.unitPrice));
  }, [quotes, mode, productFilter]);
  const activeSuppliers = suppliers.filter((supplier) => supplier.status === "active").length;
  const heading = mode === "suppliers" ? "Suppliers" : mode === "quotes" ? "Quotations" : "Supplier comparison";

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Sourcing · internal records</p><h1>{heading}</h1><p>{mode === "suppliers" ? "Keep supplier contacts and commercial terms in the private owner workspace." : mode === "quotes" ? "Record product quotations as received, without converting their currencies." : "Compare recorded offers for one product; prices in different currencies are kept separate."}</p></div>
        {mode === "suppliers" ? <button className="button button-primary" onClick={() => setSupplierDialog("new")}><Plus /> Add supplier</button> : mode === "quotes" ? <button className="button button-primary" onClick={() => setQuoteDialog("new")} disabled={!products.length || !activeSuppliers}><Plus /> Record quotation</button> : null}
      </section>

      {notice && <div className="alert alert-success" role="status">{notice}</div>}
      {error && <div className="alert alert-error" role="alert"><AlertCircle /><span>{error}</span><button className="button button-secondary button-small" onClick={() => setReload((n) => n + 1)}><RefreshCw /> Retry</button></div>}
      {loading ? <div className="panel"><div className="panel-body"><div className="skeleton-row" aria-busy="true" /></div></div> : mode === "suppliers" ? (
        <>
          <div className="toolbar"><label className="search-field"><Search /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search supplier, country or contact" aria-label="Search suppliers" /></label><span className="supplier-count">{activeSuppliers} active · {suppliers.length} total</span></div>
          {filteredSuppliers.length ? <div className="supplier-grid">{filteredSuppliers.map((supplier) => <article className="supplier-card" key={supplier.id}>
            <div className="supplier-card-top"><div><span className="supplier-country">{supplier.country || "Country not set"}</span><h2>{supplier.name}</h2></div><span className={`status-badge status-${supplier.status}`}>{supplier.status}</span></div>
            <div className="supplier-contact">{supplier.contactName || "No contact"}{supplier.email ? ` · ${supplier.email}` : ""}{supplier.phone ? ` · ${supplier.phone}` : ""}</div>
            <div className="supplier-card-meta"><span>Typical lead time <strong>{supplier.defaultLeadTimeDays} days</strong></span><span>{supplier.paymentTerms || "Payment terms not set"}</span></div>
            <div className="supplier-card-foot"><span>{supplier.website || "No website"}</span><button className="button button-secondary button-small" onClick={() => setSupplierDialog(supplier)}><Pencil /> Edit</button></div>
          </article>)}</div> : <div className="panel"><div className="empty-state"><div className="empty-mark"><Truck /></div><h3>No suppliers match this view</h3><p>Add internal supplier records; these are not marketplace seller accounts.</p><button className="button button-primary" onClick={() => setSupplierDialog("new")}><Plus /> Add supplier</button></div></div>}
          <div className="notice-strip"><Truck /><span>Making a supplier inactive keeps its profile and quotation history. It only removes that supplier from new quotations.</span></div>
        </>
      ) : mode === "quotes" ? (
        <>
          {(!products.length || !activeSuppliers) && <div className="notice-strip"><AlertCircle /><span>Add at least one product and one active supplier before recording a quotation.</span></div>}
          {shownQuotes.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Product</th><th>Supplier</th><th>Unit price</th><th>MOQ</th><th>Lead time</th><th>Valid until</th><th>Status</th><th /></tr></thead><tbody>{shownQuotes.map((quote) => <tr key={quote.id}>
            <td><span className="product-primary">{quote.productName}</span><span className="product-secondary">{quote.productSku}</span></td><td><span className="product-primary">{quote.supplierName}</span></td><td className="money-cell">{money(quote.unitPrice, quote.currency)}</td><td>{quote.minimumOrderQuantity.toLocaleString()}</td><td>{quote.leadTimeDays} days</td><td>{quote.validUntil || "—"}</td><td><span className={`status-badge status-${quote.status}`}>{quote.status}</span></td><td><button className="icon-button" aria-label={`Edit quote for ${quote.productName} from ${quote.supplierName}`} onClick={() => setQuoteDialog(quote)}><Pencil /></button></td>
          </tr>)}</tbody></table></div> : <div className="panel"><div className="empty-state"><div className="empty-mark"><ArrowLeftRight /></div><h3>No quotations recorded</h3><p>Record supplier offers against products to compare quoted prices, minimum order quantities and lead times.</p>{products.length && activeSuppliers ? <button className="button button-primary" onClick={() => setQuoteDialog("new")}><Plus /> Record quotation</button> : null}</div></div>}
          <div className="notice-strip"><AlertCircle /><span>Prices remain in each supplier's stated currency. The app does not apply exchange rates, shipping costs or landed-cost estimates to quotes.</span></div>
        </>
      ) : (
        <>
          <div className="compare-toolbar"><label className="field"><span>Product to compare</span><select value={productFilter} onChange={(e) => setProductFilter(e.target.value)}><option value="">Choose a product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}</select></label><span className="supplier-count">{shownQuotes.length} quotations</span></div>
          {productFilter && shownQuotes.length ? <div className="table-wrap"><table className="data-table comparison-table"><thead><tr><th>Supplier</th><th>Quoted unit price</th><th>Currency</th><th>Minimum order</th><th>Lead time</th><th>Shipping terms</th><th>Validity / status</th></tr></thead><tbody>{shownQuotes.map((quote) => <tr key={quote.id}><td><span className="product-primary">{quote.supplierName}</span><span className="product-secondary">{quote.quoteReference || "No quote reference"}</span></td><td className="money-cell">{money(quote.unitPrice, quote.currency)}</td><td>{quote.currency}</td><td>{quote.minimumOrderQuantity.toLocaleString()}</td><td>{quote.leadTimeDays} days</td><td>{quote.shippingTerms || "Not specified"}</td><td>{quote.validUntil || "No expiry"}<span className={`product-secondary status-text-${quote.status}`}>{quote.status}</span></td></tr>)}</tbody></table></div> : <div className="panel"><div className="empty-state"><div className="empty-mark"><ArrowLeftRight /></div><h3>{productFilter ? "No quotes for this product" : "Choose a product to compare"}</h3><p>{productFilter ? "Record quotations from suppliers to see them together here." : "The comparison shows quoted price, MOQ, lead time and terms without mixing currencies."}</p></div></div>}
          <div className="notice-strip"><AlertCircle /><span>Comparison is informational only. Quotes in different currencies are not ranked against each other, and shipping/import costs are not included.</span></div>
        </>
      )}

      {supplierDialog !== null && <SupplierModal value={supplierDialog === "new" ? null : supplierDialog} onClose={() => setSupplierDialog(null)} onSaved={(saved) => { setSupplierDialog(null); setNotice(`${saved.name} saved.`); setReload((n) => n + 1); }} />}
      {quoteDialog !== null && <QuoteModal quote={quoteDialog === "new" ? null : quoteDialog} products={products} suppliers={suppliers} onClose={() => setQuoteDialog(null)} onSaved={() => { setQuoteDialog(null); setNotice("Quotation saved."); setReload((n) => n + 1); }} />}
    </>
  );
}
