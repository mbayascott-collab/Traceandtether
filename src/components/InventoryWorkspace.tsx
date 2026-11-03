import { useEffect, useState, type FormEvent } from "react";
import {
  createInventoryAdjustment, createReservation, fetchInventory, fetchInventoryMovements,
  fetchInventoryReceipts, fetchReservations, fulfillReservation, postInventoryReceipt,
  releaseReservation, type InventoryItem, type InventoryMovement, type InventoryReceipt,
  type InventoryReservation,
} from "../lib/api";

type Mode = "overview" | "receipts" | "reservations" | "adjustments";
export default function InventoryWorkspace({ mode }: { mode: Mode }) {
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [receipts, setReceipts] = useState<InventoryReceipt[]>([]);
  const [reservations, setReservations] = useState<InventoryReservation[]>([]);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const heading = mode === "overview" ? "Inventory" : mode === "receipts" ? "Stock receipts" : mode === "reservations" ? "Reservations" : "Stock adjustments";

  useEffect(() => {
    let alive = true;
    Promise.all([fetchInventory(), fetchInventoryMovements(), fetchInventoryReceipts(), fetchReservations()])
      .then(([i, m, r, v]) => { if (alive) { setInventory(i); setMovements(m); setReceipts(r); setReservations(v); } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : "Could not load inventory."); });
    return () => { alive = false; };
  }, [reload]);

  async function submit(event: FormEvent<HTMLFormElement>, action: (data: FormData) => Promise<void>) {
    event.preventDefault(); const form = event.currentTarget; setError(""); setNotice("");
    try { await action(new FormData(form)); form.reset(); setNotice("Saved."); setReload((n) => n + 1); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save this inventory record."); }
  }
  async function run(action: () => Promise<void>) {
    setError(""); setNotice("");
    try { await action(); setNotice("Inventory updated."); setReload((n) => n + 1); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not update inventory."); }
  }
  return <section className="supplier-workspace">
    <header className="page-heading"><div><p className="eyebrow">Stock control · traceable ledger</p><h1>{heading}</h1><p>On-hand stock comes from permanent movement records. Reservations reduce available stock but do not change on-hand quantity.</p></div></header>
    {error && <div className="notice-strip" role="alert">{error}</div>}{notice && <div className="notice-strip" role="status">{notice}</div>}
    {mode === "overview" && <>
      <div className="panel data-table-wrap"><table><thead><tr><th>Product</th><th>SKU</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Unit</th></tr></thead><tbody>{inventory.map((p) => <tr key={p.id}><td>{p.name}</td><td>{p.sku}</td><td>{p.onHand}</td><td>{p.reserved}</td><td>{p.available}</td><td>{p.unit}</td></tr>)}</tbody></table></div>
      <MovementTable movements={movements} />
    </>}
    {mode === "receipts" && <div className="panel data-table-wrap"><p>Post received shipment quantities into stock. Posting is incremental and cannot be duplicated.</p><table><thead><tr><th>Order / shipment</th><th>Supplier</th><th>Product</th><th>Received</th><th>Already in stock</th><th>To post</th><th /></tr></thead><tbody>{receipts.map((r) => <tr key={r.id}><td>{r.orderNumber} · {r.shipmentReference || "shipment"}</td><td>{r.supplierName}</td><td>{r.productName} · {r.sku}</td><td>{r.quantityReceived}</td><td>{r.quantityStocked}</td><td>{r.quantityToPost}</td><td><button className="button button-primary" onClick={() => run(() => postInventoryReceipt(r.id))}>Post receipt</button></td></tr>)}{!receipts.length && <tr><td colSpan={7}>No received shipment quantities are waiting to be posted.</td></tr>}</tbody></table></div>}
    {mode === "reservations" && <>
      <form className="panel form-grid" onSubmit={(e) => submit(e, async (d) => createReservation({
        productId: Number(d.get("productId")), quantity: Number(d.get("quantity")),
        reference: String(d.get("reference") || "") || null, reason: String(d.get("reason")),
      }))}>
        <h2>Reserve available stock</h2><label>Product<select name="productId" required defaultValue=""><option value="">Choose product</option>{inventory.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku} · available {p.available}</option>)}</select></label>
        <label>Quantity<input name="quantity" type="number" min="1" required /></label><label>Reference<input name="reference" placeholder="Order or job reference" /></label>
        <label>Reason<input name="reason" required maxLength={500} /></label><button className="button button-primary">Reserve stock</button>
      </form>
      <div className="panel data-table-wrap"><table><thead><tr><th>Product</th><th>Quantity</th><th>Reference</th><th>Reason</th><th>Status</th><th>Actions</th></tr></thead><tbody>{reservations.map((r) => <tr key={r.id}><td>{r.productName} · {r.sku}</td><td>{r.quantity}</td><td>{r.reference || "—"}</td><td>{r.reason}</td><td>{r.status}</td><td>{r.status === "active" && <><button onClick={() => run(() => releaseReservation(r.id))}>Release</button> <button onClick={() => run(() => fulfillReservation(r.id))}>Fulfill</button></>}</td></tr>)}</tbody></table></div>
    </>}
    {mode === "adjustments" && <>
      <form className="panel form-grid" onSubmit={(e) => submit(e, async (d) => createInventoryAdjustment({
        productId: Number(d.get("productId")), quantityDelta: Number(d.get("quantityDelta")),
        reference: String(d.get("reference") || "") || null, reason: String(d.get("reason")),
      }))}>
        <h2>Record a stock adjustment</h2><label>Product<select name="productId" required defaultValue=""><option value="">Choose product</option>{inventory.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku} · on hand {p.onHand}</option>)}</select></label>
        <label>Change quantity<input name="quantityDelta" type="number" required placeholder="Positive to add; negative to remove" /></label>
        <label>Reference<input name="reference" /></label><label>Reason<input name="reason" required maxLength={500} /></label>
        <button className="button button-primary">Save adjustment</button>
      </form><MovementTable movements={movements.filter((m) => m.kind === "adjustment")} />
    </>}
  </section>;
}

function MovementTable({ movements }: { movements: InventoryMovement[] }) {
  return <div className="panel data-table-wrap"><h2>Movement history</h2><table><thead><tr><th>Date</th><th>Product</th><th>Type</th><th>Change</th><th>Reason</th><th>Reference</th></tr></thead><tbody>{movements.map((m) => <tr key={m.id}><td>{new Date(m.createdAt).toLocaleString()}</td><td>{m.productName} · {m.sku}</td><td>{m.kind.replaceAll("_", " ")}</td><td>{m.quantityDelta > 0 ? "+" : ""}{m.quantityDelta}</td><td>{m.reason}</td><td>{m.reference || "—"}</td></tr>)}{!movements.length && <tr><td colSpan={6}>No stock movements yet.</td></tr>}</tbody></table></div>;
}
