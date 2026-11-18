import { useEffect, useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import {
  correctOpeningStock, createInventoryAdjustment, createInventoryLocation, createOpeningStock, createReservation, fetchInventory, fetchInventoryLocations, fetchInventoryMovements,
  fetchInventoryReceipts, fetchReservations, fulfillReservation, postInventoryReceipt,
  recordInventoryEvent, releaseReservation, transferInventory, type InventoryItem, type InventoryLocation, type InventoryMovement, type InventoryReceipt,
  type InventoryReservation,
} from "../lib/api";

type Mode = "overview" | "receipts" | "reservations" | "adjustments";
const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole);
  const absolute = amount < 0n ? -amount : amount;
  const cents = fraction.padEnd(2, "0").slice(0, 2);
  return `ZMW ${amount < 0n ? "-" : ""}${absolute.toLocaleString("en-ZM")}.${cents}`;
};

export default function InventoryWorkspace({ mode }: { mode: Mode }) {
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [receipts, setReceipts] = useState<InventoryReceipt[]>([]);
  const [reservations, setReservations] = useState<InventoryReservation[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [receiptLocations, setReceiptLocations] = useState<Record<number, number>>({});
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [openingQuantity, setOpeningQuantity] = useState("");
  const [openingUnitCost, setOpeningUnitCost] = useState("");
  const [correctingMovement, setCorrectingMovement] = useState<InventoryMovement | null>(null);
  const heading = mode === "overview" ? "Inventory" : mode === "receipts" ? "Stock receipts" : mode === "reservations" ? "Reservations" : "Stock adjustments";
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredInventory = inventory.filter((product) =>
    product.name.toLocaleLowerCase().includes(normalizedSearch) ||
    product.sku.toLocaleLowerCase().includes(normalizedSearch)
  );
  const openingValueCents = (() => {
    if (!/^\d+$/.test(openingQuantity) || !/^\d+(?:\.\d{0,2})?$/.test(openingUnitCost)) return null;
    const [whole, fraction = ""] = openingUnitCost.split(".");
    return BigInt(openingQuantity) * (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")));
  })();
  const openingValue = openingValueCents === null ? null
    : `ZMW ${(openingValueCents / 100n).toLocaleString("en-ZM")}.${String(openingValueCents % 100n).padStart(2, "0")}`;

  useEffect(() => {
    let alive = true;
    Promise.all([fetchInventory(), fetchInventoryMovements(), fetchInventoryReceipts(), fetchReservations(), fetchInventoryLocations()])
      .then(([i, m, r, v, l]) => { if (alive) {
        setInventory(i); setMovements(m); setReceipts(r); setReservations(v); setLocations(l);
        setReceiptLocations((old) => Object.fromEntries(r.map((row) => [row.id, old[row.id] ?? l[0]?.id ?? 0])));
      } })
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
    <header className="page-heading"><div><p className="eyebrow">Stock control · traceable ledger</p><h1>{heading}</h1><p>On-hand stock comes from permanent movement records. Reservations reduce available stock but do not change on-hand quantity.</p>
      {mode === "overview" && <p className="report-footnote">Inventory is valued using weighted-average cost for each product. The accounting value is allocated across locations by on-hand quantity, with rounding cents assigned so location values add exactly to the product total.</p>}
    </div></header>
    {error && <div className="notice-strip" role="alert">{error}</div>}{notice && <div className="notice-strip" role="status">{notice}</div>}
    {mode === "overview" && <>
      <form className="panel form-grid" onSubmit={(e) => submit(e, async (d) => createInventoryLocation(String(d.get("name"))))}>
        <h2>Stock locations</h2><label>Location name<input name="name" minLength={2} maxLength={120} required placeholder="For example, Lusaka warehouse" /></label>
        <button className="button button-primary">Add location</button>
        <p className="report-footnote field-full">{locations.map((location) => location.name).join(" · ") || "Main location will be created when stock is first recorded."}</p>
      </form>
      <div className="toolbar">
        <label className="search-field"><Search aria-hidden="true" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by product name or SKU" aria-label="Search inventory by product name or SKU" /></label>
        <span>{filteredInventory.length} {filteredInventory.length === 1 ? "product" : "products"}</span>
      </div>
      <div className="panel data-table-wrap"><table><thead><tr><th>Product</th><th>SKU</th><th>On hand</th><th>Reserved</th><th>Available</th><th>By location · on hand / available / value</th><th>Average cost</th><th>Stock value</th><th>Unit</th></tr></thead><tbody>{filteredInventory.map((p) => <tr key={p.id}><td>{p.name}</td><td>{p.sku}</td><td>{p.onHand}</td><td>{p.reserved}</td><td>{p.available}</td><td>{p.locations.map((l) => `${l.name}: ${l.onHand} / ${l.available} / ${money(l.stockValueZmw)}`).join(" · ") || "Main: 0"}</td><td>{money(p.averageUnitCostZmw)}</td><td>{money(p.stockValueZmw)}</td><td>{p.unit}</td></tr>)}{!filteredInventory.length && <tr><td colSpan={9}>{normalizedSearch ? "No products match that name or SKU." : "No products found."}</td></tr>}</tbody></table></div>
    </>}
    {mode === "receipts" && <div className="panel data-table-wrap"><p>Post received shipment quantities into stock. Posting is incremental and cannot be duplicated.</p><table><thead><tr><th>Order / shipment</th><th>Supplier</th><th>Product</th><th>Received</th><th>Already in stock</th><th>To post</th><th>Location</th><th /></tr></thead><tbody>{receipts.map((r) => <tr key={r.id}><td>{r.orderNumber} · {r.shipmentReference || "shipment"}</td><td>{r.supplierName}</td><td>{r.productName} · {r.sku}</td><td>{r.quantityReceived}</td><td>{r.quantityStocked}</td><td>{r.quantityToPost}</td><td><select aria-label={`Receiving location for ${r.productName}`} value={receiptLocations[r.id] ?? ""} onChange={(e) => setReceiptLocations((old) => ({ ...old, [r.id]: Number(e.target.value) }))}><option value="">Choose location</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></td><td><button className="button button-primary" disabled={!receiptLocations[r.id]} onClick={() => run(() => postInventoryReceipt(r.id, receiptLocations[r.id]))}>Post receipt</button></td></tr>)}{!receipts.length && <tr><td colSpan={8}>No received shipment quantities are waiting to be posted.</td></tr>}</tbody></table></div>}
    {mode === "reservations" && <>
      <form className="panel form-grid" onSubmit={(e) => submit(e, async (d) => createReservation({
        productId: Number(d.get("productId")), locationId: Number(d.get("locationId")), quantity: Number(d.get("quantity")),
        reference: String(d.get("reference") || "") || null, reason: String(d.get("reason")),
      }))}>
        <h2>Reserve available stock</h2><label>Product<select name="productId" required defaultValue=""><option value="">Choose product</option>{inventory.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku}</option>)}</select></label>
        <label>Location<select name="locationId" required defaultValue=""><option value="">Choose location</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Quantity<input name="quantity" type="number" min="1" required /></label><label>Reference<input name="reference" placeholder="Order or job reference" /></label>
        <label>Reason<input name="reason" required maxLength={500} /></label><button className="button button-primary">Reserve stock</button>
      </form>
      <div className="panel data-table-wrap"><table><thead><tr><th>Product</th><th>Location</th><th>Quantity</th><th>Reference</th><th>Reason</th><th>Status</th><th>Actions</th></tr></thead><tbody>{reservations.map((r) => <tr key={r.id}><td>{r.productName} · {r.sku}</td><td>{r.locationName || "Main"}</td><td>{r.quantity}</td><td>{r.reference || "—"}</td><td>{r.reason}</td><td>{r.status}</td><td>{r.status === "active" && (r.salesOrderId ? "Manage through sales order" : <><button onClick={() => run(() => releaseReservation(r.id))}>Release</button> <button onClick={() => run(() => fulfillReservation(r.id))}>Fulfill</button></>)}</td></tr>)}</tbody></table></div>
    </>}
    {mode === "adjustments" && <>
      <form className="panel form-grid" onSubmit={(e) => submit(e, async (d) => transferInventory({
        productId: Number(d.get("productId")), fromLocationId: Number(d.get("fromLocationId")),
        toLocationId: Number(d.get("toLocationId")), quantity: Number(d.get("quantity")),
        reference: String(d.get("reference") || "") || null, reason: String(d.get("reason")),
      }))}>
        <h2>Transfer stock between locations</h2>
        <label>Product<select name="productId" required defaultValue=""><option value="">Choose product</option>{inventory.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku}</option>)}</select></label>
        <label>From<select name="fromLocationId" required defaultValue=""><option value="">Choose source</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>To<select name="toLocationId" required defaultValue=""><option value="">Choose destination</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Quantity<input name="quantity" type="number" min="1" step="1" required /></label>
        <label>Reason<input name="reason" minLength={3} maxLength={500} required /></label>
        <label>Reference<input name="reference" maxLength={120} /></label>
        <button className="button button-primary">Transfer stock</button>
      </form>
      <form className="panel form-grid" onSubmit={(e) => submit(e, async (d) => recordInventoryEvent({
        kind: String(d.get("kind")) as "stock_return" | "stock_damage", productId: Number(d.get("productId")),
        locationId: Number(d.get("locationId")), quantity: Number(d.get("quantity")),
        reference: String(d.get("reference") || "") || null, reason: String(d.get("reason")),
      }))}>
        <h2>Record other returned stock or damage</h2>
        <p className="report-footnote field-full">For a customer return from a sales delivery, use “Record return” next to that delivery item on the Sales orders page. This stock event does not change a customer balance.</p>
        <label>Type<select name="kind" defaultValue="stock_return"><option value="stock_return">Returned to usable stock</option><option value="stock_damage">Damaged and written off</option></select></label>
        <label>Product<select name="productId" required defaultValue=""><option value="">Choose product</option>{inventory.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku}</option>)}</select></label>
        <label>Location<select name="locationId" required defaultValue=""><option value="">Choose location</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Quantity<input name="quantity" type="number" min="1" step="1" required /></label>
        <label>Reason<input name="reason" minLength={3} maxLength={500} required /></label>
        <label>Reference<input name="reference" maxLength={120} /></label>
        <button className="button button-primary">Save stock event</button>
      </form>
      <form className="panel form-grid" onSubmit={(e) => submit(e, async (d) => createInventoryAdjustment({
        productId: Number(d.get("productId")), locationId: Number(d.get("locationId")), quantityDelta: Number(d.get("quantityDelta")),
        reference: String(d.get("reference") || "") || null, reason: String(d.get("reason")),
      }))}>
        <h2>Record a stock adjustment</h2><label>Product<select name="productId" required defaultValue=""><option value="">Choose product</option>{inventory.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku} · on hand {p.onHand}</option>)}</select></label>
        <label>Location<select name="locationId" required defaultValue=""><option value="">Choose location</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Change quantity<input name="quantityDelta" type="number" required placeholder="Positive to add; negative to remove" /></label>
        <label>Reference<input name="reference" /></label><label>Reason<input name="reason" required maxLength={500} /></label>
        <button className="button button-primary">Save adjustment</button>
      </form>
      <form className="panel form-grid" onSubmit={(e) => submit(e, async (d) => {
        const evidence = d.get("evidence");
        return createOpeningStock({
          productId: Number(d.get("productId")), locationId: Number(d.get("locationId")), quantity: Number(d.get("quantity")),
          unitCostZmw: String(d.get("unitCostZmw")), effectiveAt: String(d.get("effectiveAt")),
          memo: String(d.get("memo")), reference: String(d.get("reference") || "") || null,
          evidence: evidence instanceof File && evidence.size > 0 ? evidence : null,
        });
      })} onReset={() => { setOpeningQuantity(""); setOpeningUnitCost(""); }}>
        <h2>Add stock you already have</h2>
        <p className="report-footnote field-full">Enter the counted quantity and reviewed average landed cost per unit in ZMW for this location. The stock value is recorded against opening balance equity, not sales income. Use this once per product at each location; later changes belong in stock adjustments.</p>
        <label>Product<select name="productId" required defaultValue=""><option value="">Choose product</option>{inventory.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku} · currently {p.onHand}</option>)}</select></label>
        <label>Location<select name="locationId" required defaultValue=""><option value="">Choose location</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Quantity to add<input name="quantity" type="number" min="1" max="1000000" step="1" value={openingQuantity} onChange={(event) => setOpeningQuantity(event.target.value)} required /></label>
        <label>Average cost per unit (ZMW)<input name="unitCostZmw" type="number" min="0.01" step="0.01" value={openingUnitCost} onChange={(event) => setOpeningUnitCost(event.target.value)} required /></label>
        <p className="report-footnote field-full" aria-live="polite">Calculated opening stock value: {openingValue ?? "Enter a quantity and unit cost"}</p>
        <label>Effective date<input name="effectiveAt" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
        <label>Memo<input name="memo" maxLength={500} defaultValue="Reviewed opening stock" required /></label>
        <label>Reference<input name="reference" maxLength={120} placeholder="Opening count or source note" /></label>
        <label>Count worksheet or photo<input name="evidence" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" /></label>
        <p className="report-footnote field-full">Optional: attach one PDF or photo, up to 5 MB. The file is saved with the opening entry and cannot be replaced or removed.</p>
        <button className="button button-primary">Record opening stock</button>
      </form>
      {correctingMovement && <form className="panel form-grid" onSubmit={(event) => submit(event, async (d) => {
        await correctOpeningStock(correctingMovement.id, {
          quantity: Number(d.get("quantity")),
          unitCostZmw: String(d.get("unitCostZmw")),
          effectiveAt: String(d.get("effectiveAt")),
          reason: String(d.get("reason")).trim(),
          reference: String(d.get("reference") || "") || null,
        });
        setCorrectingMovement(null);
      })}>
        <h2>Correct opening count · {correctingMovement.productName} at {correctingMovement.locationName || "Unassigned"}</h2>
        <p className="report-footnote field-full">The original count will remain in history. The system will post a reasoned reversal and a linked replacement count. Existing reservations cannot be reduced below available stock.</p>
        <label>Correct quantity<input name="quantity" type="number" min="1" max="1000000" step="1" defaultValue={correctingMovement.quantityDelta} required /></label>
        <label>Correct average cost per unit (ZMW)<input name="unitCostZmw" type="number" min="0.01" step="0.01" required /></label>
        <label>Correction date<input name="effectiveAt" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
        <label>Reason for correction<input name="reason" minLength={3} maxLength={500} required /></label>
        <label>Reference<input name="reference" maxLength={120} defaultValue={correctingMovement.reference ?? ""} /></label>
        <button className="button button-primary">Reverse and replace count</button>
        <button type="button" className="button button-secondary" onClick={() => setCorrectingMovement(null)}>Cancel</button>
      </form>}
      <MovementTable
        movements={movements.filter((m) => m.kind === "adjustment" || m.kind === "opening_stock" || m.kind === "opening_stock_reversal")}
        onCorrect={setCorrectingMovement}
      />
    </>}
  </section>;
}

function MovementTable({ movements, onCorrect }: { movements: InventoryMovement[]; onCorrect: (movement: InventoryMovement) => void }) {
  const correctedBy = new Map(movements.filter((movement) => movement.correctionOfMovementId !== null)
    .map((movement) => [movement.correctionOfMovementId!, movement]));
  return <div className="panel data-table-wrap"><h2>Movement history</h2><table><thead><tr><th>Date</th><th>Product</th><th>Location</th><th>Type</th><th>Change</th><th>Reason</th><th>Correction link</th><th>Reference</th><th>Evidence</th></tr></thead><tbody>{movements.map((m) => {
    const child = correctedBy.get(m.id);
    const correctionLink = m.kind === "opening_stock_reversal"
      ? `Reverses #${m.correctionOfMovementId}`
      : m.correctionOfMovementId !== null
        ? `Replaces reversal #${m.correctionOfMovementId}`
        : child ? `Corrected by #${child.id}` : "—";
    return <tr key={m.id}><td>{new Date(m.createdAt).toLocaleString()}</td><td>{m.productName} · {m.sku}</td><td>{m.locationName || "Main"}</td><td>{m.kind.replaceAll("_", " ")}</td><td>{m.quantityDelta > 0 ? "+" : ""}{m.quantityDelta}</td><td>{m.reason}</td><td>{correctionLink}{m.kind === "opening_stock" && !child && <><br /><button type="button" className="button button-secondary button-small" onClick={() => onCorrect(m)}>Correct count</button></>}</td><td>{m.reference || "—"}</td><td>{m.evidenceFileName ? <a href={`/api/inventory/movements/${m.id}/opening-evidence`} target="_blank" rel="noreferrer">{m.evidenceFileName}</a> : "—"}</td></tr>;
  })}{!movements.length && <tr><td colSpan={9}>No stock movements yet.</td></tr>}</tbody></table></div>;
}
