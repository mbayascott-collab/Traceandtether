import { useEffect, useState, type FormEvent } from "react";
import {
  createImportExpense, createPurchaseOrder, createShipment, fetchImportExpenses, fetchLandedCosts,
  postLandedCostAdjustment,
  fetchProducts, fetchPurchaseOrders, fetchShipments, fetchSuppliers, receiveShipment,
  type ImportExpense, type LandedCostOrder, type PurchaseOrder, type Product, type Shipment, type Supplier,
} from "../lib/api";

type Mode = "orders" | "shipments" | "expenses" | "landed";
type LineDraft = { productId: string; quantityOrdered: string; unitPrice: string };
type ShipmentLineDraft = { purchaseOrderLineId: string; quantityShipped: string };
const today = () => new Date().toISOString().slice(0, 10);
const money = (value: string, currency = "ZMW") => `${currency} ${Number(value).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function ProcurementWorkspace({ mode }: { mode: Mode }) {
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [expenses, setExpenses] = useState<ImportExpense[]>([]);
  const [costs, setCosts] = useState<LandedCostOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([{ productId: "", quantityOrdered: "1", unitPrice: "" }]);
  const [shipmentLineDrafts, setShipmentLineDrafts] = useState<ShipmentLineDraft[]>([{ purchaseOrderLineId: "", quantityShipped: "1" }]);
  const [shipmentOrderIds, setShipmentOrderIds] = useState<string[]>([]);
  const [shipmentOrderToAdd, setShipmentOrderToAdd] = useState("");
  const [expenseTargetType, setExpenseTargetType] = useState<"order" | "shipment">("order");
  const [reviewNotes, setReviewNotes] = useState<Record<number, string>>({});
  const [adjustingOrderId, setAdjustingOrderId] = useState<number | null>(null);
  const heading = mode === "orders" ? "Purchase orders" : mode === "shipments" ? "Shipments" : mode === "expenses" ? "Import expenses" : "Landed costs";

  useEffect(() => {
    let alive = true;
    Promise.all([fetchPurchaseOrders(), fetchShipments(), fetchImportExpenses(), fetchLandedCosts(), fetchProducts({ page: 1, pageSize: 100 }), fetchSuppliers()])
      .then(([o, s, e, c, p, v]) => { if (alive) { setOrders(o); setShipments(s); setExpenses(e); setCosts(c); setProducts(p.products); setSuppliers(v); } })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not load procurement data."); });
    return () => { alive = false; };
  }, [reload]);

  async function submit(event: FormEvent<HTMLFormElement>, action: (data: FormData) => Promise<void>) {
    event.preventDefault(); setError(""); setNotice("");
    const form = event.currentTarget;
    try { await action(new FormData(form)); setNotice("Saved."); setReload((n) => n + 1); form.reset(); setShipmentOrderIds([]); setShipmentOrderToAdd(""); setShipmentLineDrafts([{ purchaseOrderLineId: "", quantityShipped: "1" }]); setExpenseTargetType("order"); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not save this record."); }
  }

  async function postReviewedAdjustment(order: LandedCostOrder) {
    const preview = order.adjustmentPreview;
    const note = reviewNotes[order.id]?.trim();
    if (!preview?.canPost || !note) return;
    setError(""); setNotice(""); setAdjustingOrderId(order.id);
    try {
      await postLandedCostAdjustment(order.id, preview, note);
      setNotice(`Reviewed adjustment posted for ${order.orderNumber}.`);
      setReviewNotes((current) => ({ ...current, [order.id]: "" }));
      setReload((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post the reviewed adjustment.");
    } finally {
      setAdjustingOrderId(null);
    }
  }

  const activeOrders = orders.filter((order) => order.status !== "cancelled" && order.status !== "received");
  const selectedShipmentOrders = orders.filter((order) => shipmentOrderIds.includes(String(order.id)));
  const availableShipmentOrderLines = selectedShipmentOrders.flatMap((order) => order.lines
    .filter((line) => !shipmentLineDrafts.some((draft) => draft.purchaseOrderLineId === String(line.id)))
    .map((line) => ({ ...line, orderNumber: order.orderNumber, supplierName: order.supplierName })));
  const shipmentReady = selectedShipmentOrders.length > 0 && selectedShipmentOrders.every((order) =>
    order.lines.some((line) => shipmentLineDrafts.some((draft) => draft.purchaseOrderLineId === String(line.id))));
  return <section className="supplier-workspace">
    <header className="page-heading"><div><p className="eyebrow">Purchasing · internal records</p><h1>{heading}</h1><p>Track orders, deliveries and import costs. Exchange rates are entered by you and are never inferred.</p></div></header>
    {error && <div className="notice-strip" role="alert">{error}</div>}{notice && <div className="notice-strip" role="status">{notice}</div>}
    {mode === "orders" && <>
      <form className="panel form-grid" onSubmit={(e) => submit(e, async (d) => createPurchaseOrder({
        supplierId: Number(d.get("supplierId")), currency: String(d.get("currency")).toUpperCase(), exchangeRateToZmw: String(d.get("exchangeRateToZmw")),
        expectedAt: String(d.get("expectedAt") || "") || null, notes: String(d.get("notes") || "") || null,
        lines: lines.map((line) => ({ productId: Number(line.productId), quantityOrdered: Number(line.quantityOrdered), unitPrice: line.unitPrice })),
      }))}>
        <h2>Create purchase order</h2>
        <label>Supplier<select name="supplierId" required defaultValue=""><option value="" disabled>Select supplier</option>{suppliers.filter((s) => s.status === "active").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Order currency<input name="currency" required maxLength={3} defaultValue="CNY" /></label>
        <label>Rate to ZMW<input name="exchangeRateToZmw" required inputMode="decimal" placeholder="e.g. 3.20" /></label>
        <label>Expected date<input name="expectedAt" type="date" /></label>
        <div className="form-grid">{lines.map((line, i) => <div className="form-grid" key={i}>
          <label>Product<select required value={line.productId} onChange={(e) => setLines((ls) => ls.map((v, n) => n === i ? { ...v, productId: e.target.value } : v))}><option value="">Select product</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku}</option>)}</select></label>
          <label>Quantity<input type="number" min="1" required value={line.quantityOrdered} onChange={(e) => setLines((ls) => ls.map((v, n) => n === i ? { ...v, quantityOrdered: e.target.value } : v))} /></label>
          <label>Unit price<input inputMode="decimal" required value={line.unitPrice} onChange={(e) => setLines((ls) => ls.map((v, n) => n === i ? { ...v, unitPrice: e.target.value } : v))} /></label>
          {lines.length > 1 && <button type="button" onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))}>Remove line</button>}
        </div>)}</div>
        <button type="button" className="button button-secondary" onClick={() => setLines((ls) => [...ls, { productId: "", quantityOrdered: "1", unitPrice: "" }])}>Add product line</button>
        <label>Notes<input name="notes" /></label><button className="button button-primary">Create order</button>
      </form>
      <div className="panel data-table-wrap"><table><thead><tr><th>Order</th><th>Supplier</th><th>Products</th><th>Currency · FX to ZMW</th><th>Expected</th><th>Status</th></tr></thead><tbody>{orders.map((o) => <tr key={o.id}><td>{o.orderNumber}</td><td>{o.supplierName}</td><td>{o.lines.map((l) => `${l.productName} × ${l.quantityOrdered}`).join(", ")}</td><td>{o.currency} · {o.exchangeRateToZmw}</td><td>{o.expectedAt || "—"}</td><td>{o.status.replaceAll("_", " ")}</td></tr>)}</tbody></table></div>
    </>}
    {mode === "shipments" && <>
      <form className="panel form-grid" onSubmit={(e) => submit(e, async (d) => createShipment({
        purchaseOrderIds: shipmentOrderIds.map(Number), shipmentReference: String(d.get("shipmentReference") || "") || null,
        carrier: String(d.get("carrier") || "") || null, trackingNumber: String(d.get("trackingNumber") || "") || null,
        shippedAt: String(d.get("shippedAt") || "") || null, expectedAt: String(d.get("expectedAt") || "") || null, notes: null,
        lines: shipmentLineDrafts.map((line) => ({ purchaseOrderLineId: Number(line.purchaseOrderLineId), quantityShipped: Number(line.quantityShipped) })),
      }))}>
        <h2>Record forwarder shipment</h2>
        <p>Select each supplier purchase order included in this shipment, then add the products packed in it.</p>
        <label>Add purchase order<select value={shipmentOrderToAdd} onChange={(e) => setShipmentOrderToAdd(e.target.value)}><option value="">Select order</option>{activeOrders.filter((o) => !shipmentOrderIds.includes(String(o.id))).map((o) => <option key={o.id} value={o.id}>{o.orderNumber} · {o.supplierName}</option>)}</select></label>
        <button type="button" className="button button-secondary" disabled={!shipmentOrderToAdd} onClick={() => { setShipmentOrderIds((current) => [...current, shipmentOrderToAdd]); setShipmentOrderToAdd(""); }}>Add order to shipment</button>
        {selectedShipmentOrders.map((order) => <div className="notice-strip" key={order.id}>
          {order.orderNumber} · {order.supplierName}
          <button type="button" onClick={() => { setShipmentOrderIds((current) => current.filter((id) => id !== String(order.id))); setShipmentLineDrafts((current) => current.filter((draft) => !order.lines.some((line) => String(line.id) === draft.purchaseOrderLineId))); }}>Remove order</button>
        </div>)}
        <h3>Products in this shipment</h3>
        {shipmentLineDrafts.map((line, i) => <div className="form-grid" key={i}>
          <label>Product and supplier order<select required value={line.purchaseOrderLineId} onChange={(e) => setShipmentLineDrafts((current) => current.map((item, n) => n === i ? { ...item, purchaseOrderLineId: e.target.value } : item))}><option value="">Select product</option>{selectedShipmentOrders.flatMap((order) => order.lines
              .filter((candidate) => !shipmentLineDrafts.some((selected, n) => n !== i && selected.purchaseOrderLineId === String(candidate.id)))
              .map((candidate) => ({ ...candidate, orderNumber: order.orderNumber, supplierName: order.supplierName })))
            .map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.productName} · {candidate.sku} · {candidate.orderNumber} · {candidate.supplierName}</option>)}</select></label>
          <label>Quantity shipped<input type="number" min="1" required value={line.quantityShipped} onChange={(e) => setShipmentLineDrafts((current) => current.map((item, n) => n === i ? { ...item, quantityShipped: e.target.value } : item))} /></label>
          {shipmentLineDrafts.length > 1 && <button type="button" onClick={() => setShipmentLineDrafts((current) => current.filter((_, n) => n !== i))}>Remove line</button>}
        </div>)}
        <button type="button" className="button button-secondary" disabled={!availableShipmentOrderLines.length} onClick={() => setShipmentLineDrafts((current) => [...current, { purchaseOrderLineId: "", quantityShipped: "1" }])}>Add product line</button>
        <label>Shipment reference<input name="shipmentReference" /></label><label>Carrier<input name="carrier" /></label><label>Tracking number<input name="trackingNumber" /></label>
        <label>Shipped date<input name="shippedAt" type="date" /></label><label>Expected date<input name="expectedAt" type="date" /></label>
        <button className="button button-primary" disabled={!shipmentReady}>Save shipment</button>
      </form>
      {shipments.map((s) => <div className="panel data-table-wrap" key={s.id}><h2>{s.shipmentReference || `Shipment #${s.id}`}</h2><p>Orders: {s.orderNumbers.join(", ")} · Suppliers: {s.supplierNames.join(", ")}</p><p>{s.carrier || "Carrier not recorded"} · {s.trackingNumber || "No tracking number"} · {s.status.replaceAll("_", " ")}</p><form onSubmit={(e) => submit(e, async (d) => receiveShipment(s.id, s.lines.map((line) => ({ shipmentLineId: line.id, quantityReceived: Number(d.get(`received-${line.id}`)) }))))}><table><thead><tr><th>Product / order</th><th>Shipped</th><th>Received</th><th>Update total received</th></tr></thead><tbody>{s.lines.map((line) => <tr key={line.id}><td>{line.productName} · {line.sku}<br />{line.orderNumber} · {line.supplierName}</td><td>{line.quantityShipped}</td><td>{line.quantityReceived}</td><td><input name={`received-${line.id}`} type="number" min="0" max={line.quantityShipped} defaultValue={line.quantityReceived} /></td></tr>)}</tbody></table><button className="button button-primary">Update receipt</button></form></div>)}
    </>}
    {mode === "expenses" && <>
      <form className="panel form-grid" onSubmit={(e) => submit(e, async (d) => createImportExpense({
        purchaseOrderId: expenseTargetType === "order" ? Number(d.get("purchaseOrderId")) : null,
        shipmentId: expenseTargetType === "shipment" ? Number(d.get("shipmentId")) : null,
        category: String(d.get("category")), description: String(d.get("description")),
        amount: String(d.get("amount")), currency: String(d.get("currency")).toUpperCase(), exchangeRateToZmw: String(d.get("exchangeRateToZmw")),
        basis: String(d.get("basis")) as "value" | "quantity", incurredAt: String(d.get("incurredAt") || "") || null,
        reference: String(d.get("reference") || "") || null, notes: null,
      }))}>
        <h2>Record import expense</h2>
        <label>Apply expense to<select value={expenseTargetType} onChange={(e) => setExpenseTargetType(e.target.value as "order" | "shipment")}><option value="order">One purchase order</option><option value="shipment">A shared shipment</option></select></label>
        {expenseTargetType === "order"
          ? <label>Purchase order<select name="purchaseOrderId" required defaultValue=""><option value="">Select order</option>{orders.filter((o) => o.status !== "cancelled").map((o) => <option key={o.id} value={o.id}>{o.orderNumber} · {o.supplierName}</option>)}</select></label>
          : <label>Shipment<select name="shipmentId" required defaultValue=""><option value="">Select shipment</option>{shipments.filter((s) => s.status !== "cancelled").map((s) => <option key={s.id} value={s.id}>{s.shipmentReference || `Shipment #${s.id}`} · {s.orderNumbers.join(", ")}</option>)}</select></label>}
        <label>Category<input name="category" required placeholder="Freight, customs, clearing…" /></label><label>Description<input name="description" required /></label>
        <label>Amount<input name="amount" inputMode="decimal" required /></label><label>Currency<input name="currency" maxLength={3} defaultValue="ZMW" required /></label>
        <label>Rate to ZMW<input name="exchangeRateToZmw" inputMode="decimal" defaultValue="1" required /></label>
        <label>Allocate by<select name="basis"><option value="value">Order line value</option><option value="quantity">Quantity</option></select></label>
        <label>Date<input name="incurredAt" type="date" defaultValue={today()} /></label><label>Reference<input name="reference" /></label>
        <button className="button button-primary">Save expense</button>
      </form>
      <div className="panel data-table-wrap"><table><thead><tr><th>Order / shipment</th><th>Expense</th><th>Recorded amount</th><th>FX to ZMW</th><th>Basis</th><th>Date</th></tr></thead><tbody>{expenses.map((x) => {
        const shipment = x.shipmentId !== null ? shipments.find((item) => item.id === x.shipmentId) : null;
        return <tr key={x.id}><td>{shipment
          ? `${shipment.shipmentReference || `Shipment #${shipment.id}`} · ${shipment.orderNumbers.join(", ")}`
          : orders.find((o) => o.id === x.purchaseOrderId)?.orderNumber}</td><td>{x.category} · {x.description}</td><td>{money(x.amount, x.currency)}</td><td>{x.exchangeRateToZmw}</td><td>{x.basis}</td><td>{x.incurredAt}</td></tr>;
      })}</tbody></table></div>
    </>}
    {mode === "landed" && <>
      <div className="notice-strip">Expenses use their recorded exchange rates. The adjustment preview keeps costs for stock not yet posted in clearing, and estimates the inventory share using each product’s current weighted-average value. Sold stock is assigned to cost of goods sold.</div>
      {costs.map((o) => <div className="panel data-table-wrap" key={o.id}>
        <h2>{o.orderNumber} · {o.supplierName}</h2>
        <p>Purchase FX: 1 {o.currency} = {o.exchangeRateToZmw} ZMW</p>
        <table><thead><tr><th>Product</th><th>Qty</th><th>Unit buy (ZMW)</th><th>Allocated expenses (ZMW)</th><th>Landed/unit (ZMW)</th></tr></thead><tbody>{o.lines.map((l) => <tr key={l.id}><td>{l.productName} · {l.sku}</td><td>{l.quantityOrdered}</td><td>{money(l.purchaseUnitCostZmw)}</td><td>{money(l.allocatedExpensesZmw)}</td><td>{money(l.landedUnitCostZmw)}</td></tr>)}</tbody></table>
        {o.adjustmentPreview && <>
          <h3>Outstanding clearing and reviewed adjustment</h3>
          <p>Clearing balance: <strong>{money(o.adjustmentPreview.clearingBalanceZmw)}</strong> · Ready for posted stock: <strong>{money(o.adjustmentPreview.adjustmentAvailableZmw)}</strong> · Still awaiting stock posting: <strong>{money(o.adjustmentPreview.unpostedClearingZmw)}</strong></p>
          <div className="data-table-wrap"><table><thead><tr><th>Product</th><th>Posted qty</th><th>On hand</th><th>Weighted-average unit value</th><th>Correction</th><th>Inventory</th><th>Cost of goods sold</th></tr></thead><tbody>
            {o.adjustmentPreview.lines.map((line) => <tr key={line.lineId}>
              <td>{line.productName} · {o.lines.find((item) => item.id === line.lineId)?.sku}</td>
              <td>{line.stockedQuantity}</td><td>{line.onHand}</td><td>{money(line.averageUnitCostZmw)}</td>
              <td>{money(line.adjustmentZmw)}</td><td>{money(line.inventoryZmw)}</td><td>{money(line.cogsZmw)}</td>
            </tr>)}
          </tbody></table></div>
          {o.adjustmentPreview.hasNegativeLine && <div className="notice-strip" role="alert">This order has a product-level difference that needs accounting review. No adjustment can be posted from this preview.</div>}
          {o.adjustmentPreview.canPost && <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void postReviewedAdjustment(o); }}>
            <label>Review note<input required maxLength={240} value={reviewNotes[o.id] ?? ""} onChange={(event) => setReviewNotes((current) => ({ ...current, [o.id]: event.target.value }))} placeholder="Why this late cost is being cleared" /></label>
            <button className="button button-primary" disabled={adjustingOrderId !== null || !reviewNotes[o.id]?.trim()}>
              {adjustingOrderId === o.id ? "Posting…" : `Post reviewed adjustment · ${money(o.adjustmentPreview.adjustmentAvailableZmw)}`}
            </button>
          </form>}
        </>}
      </div>)}
    </>}
  </section>;
}
