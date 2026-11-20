import { useEffect, useState, type FormEvent } from "react";
import companyLogo from "../../attached_assets/google_profile_1793771922305.png";
import {
  addSalesDeliveryReceiptProof, createSalesDelivery, createSalesOrder, deleteSalesOrder, fetchCustomers, fetchInventoryLocations, fetchMarketingCampaigns, fetchProducts, fetchPublicShopOrderAttemptCsv, fetchPublicShopOrderAttemptDays, fetchPublicShopOrderAttemptSummary, fetchSalesOrders, recordSalesReturn, saveCustomer, saveSalesDeliveryReceipt, salesDeliveryReceiptProofFileUrl, salesDeliveryReceiptProofUrl, sendSalesDeliveryInvoice, setSalesOrderAttribution, updateSalesOrderStatus,
  type Customer, type InventoryLocation, type MarketingCampaignOption, type Product, type PublicShopAttemptDay, type PublicShopBlockedSpike, type PublicShopAttemptSummary, type SalesDelivery, type SalesOrder,
} from "../lib/api";
import { pageCustomerPurchaseHistory } from "../lib/customer-purchase-history";
import { describeDeliveryNoteLocations } from "../lib/delivery-note-locations";
import { processDeliveryProofUploads, type DeliveryProofUpload } from "../lib/delivery-proof-upload";
import { salesInvoiceDocument } from "../lib/sales-invoice-document";
import { clearSalesProofRetryKey, getSalesProofRetryKey } from "../lib/sales-proof-retry";
import { chooseSalesStockAllocations } from "../../shared/sales-stock-allocation";

type Mode = "customers" | "orders";
type Line = { productId: string; quantity: string; unitPriceZmw: string };
type ReceiptProofUpload = DeliveryProofUpload<File>;
const emptyLine = (): Line => ({ productId: "", quantity: "1", unitPriceZmw: "" });
const zmw = (amount: string) => `ZMW ${Number(amount).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const companyName = "Trace and Tether Craft Studio Limited";
const companyAddress = "164 Mpundu Street, Chelston Extension, Lusaka, Zambia";
const companyEmail = "traceandtether@gmail.com";
const companyPhone = "+260-0977-101-967";
function publicShopDateOffset(daysAgo: number) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}
function suggestedStockAllocations(line: SalesOrder["lines"][number]) {
  const result = chooseSalesStockAllocations(line.stockLocations, line.quantity, null);
  return "error" in result ? [] : result.allocations;
}
function reservedDeliveryLocations(line: SalesOrder["lines"][number]) {
  const byLocation = new Map<number, { locationId: number; locationName: string; quantity: number }>();
  for (const reservation of line.stockReservations) {
    if (reservation.status !== "active" || reservation.locationId === null) continue;
    const existing = byLocation.get(reservation.locationId);
    if (existing) existing.quantity += reservation.quantity;
    else byLocation.set(reservation.locationId, {
      locationId: reservation.locationId,
      locationName: reservation.locationName || "Stock",
      quantity: reservation.quantity,
    });
  }
  return [...byLocation.values()].sort((left, right) => left.locationName.localeCompare(right.locationName));
}
export default function SalesWorkspace({ mode }: { mode: Mode }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [inventoryLocations, setInventoryLocations] = useState<InventoryLocation[]>([]);
  const [campaigns, setCampaigns] = useState<MarketingCampaignOption[]>([]);
  const [shopAttemptSummary, setShopAttemptSummary] = useState<PublicShopAttemptSummary | null>(null);
  const [shopAttemptFrom, setShopAttemptFrom] = useState(() => publicShopDateOffset(29));
  const [shopAttemptTo, setShopAttemptTo] = useState(() => publicShopDateOffset(0));
  const [shopAttemptDays, setShopAttemptDays] = useState<PublicShopAttemptDay[] | null>(null);
  const [shopAttemptBlockedSpikes, setShopAttemptBlockedSpikes] = useState<PublicShopBlockedSpike[]>([]);
  const [shopAttemptDaysRange, setShopAttemptDaysRange] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [historyCustomer, setHistoryCustomer] = useState<Customer | null>(null);
  const [purchaseHistorySearch, setPurchaseHistorySearch] = useState("");
  const [purchaseHistoryVisibleCount, setPurchaseHistoryVisibleCount] = useState(25);
  const [customerSearch, setCustomerSearch] = useState("");
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [orderActionErrors, setOrderActionErrors] = useState<Record<number, string>>({});
  const [busyOrderId, setBusyOrderId] = useState<number | null>(null);
  const [stockLocationChoices, setStockLocationChoices] = useState<Record<string, number | "auto">>({});
  const [invoicePrint, setInvoicePrint] = useState<{ order: SalesOrder; delivery: SalesDelivery | null } | null>(null);
  const [deliveryInvoiceSendingId, setDeliveryInvoiceSendingId] = useState<number | null>(null);
  const [deliveryInvoiceFeedback, setDeliveryInvoiceFeedback] = useState<Record<number, { kind: "success" | "error"; message: string }>>({});
  const [deliveryFormOrder, setDeliveryFormOrder] = useState<SalesOrder | null>(null);
  const [deliveryRequestKey, setDeliveryRequestKey] = useState("");
  const [deliverySubmitting, setDeliverySubmitting] = useState(false);
  const [deliveryPrint, setDeliveryPrint] = useState<{ order: SalesOrder; delivery: SalesDelivery | null } | null>(null);
  const [receiptDelivery, setReceiptDelivery] = useState<{ order: SalesOrder; delivery: SalesDelivery } | null>(null);
  const [receiptSubmitting, setReceiptSubmitting] = useState(false);
  const [receiptProofUploads, setReceiptProofUploads] = useState<ReceiptProofUpload[]>([]);
  const [returnForm, setReturnForm] = useState<{
    order: SalesOrder; delivery: SalesDelivery; line: SalesDelivery["lines"][number]; idempotencyKey: string;
  } | null>(null);
  const [returnSubmitting, setReturnSubmitting] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.all([
      fetchCustomers(), fetchSalesOrders(), fetchProducts({ page: 1, pageSize: 100 }), fetchMarketingCampaigns(),
      mode === "orders" ? fetchPublicShopOrderAttemptSummary() : Promise.resolve(null),
      mode === "orders" ? fetchInventoryLocations() : Promise.resolve([]),
    ])
      .then(([c, o, p, m, summary, locations]) => { if (alive) { setCustomers(c); setOrders(o); setProducts(p.products); setCampaigns(m); setShopAttemptSummary(summary); setInventoryLocations(locations); } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : "Could not load sales records."); });
    return () => { alive = false; };
  }, [reload, mode]);
  useEffect(() => {
    if (mode !== "orders") return;
    if (!shopAttemptFrom || !shopAttemptTo || shopAttemptFrom > shopAttemptTo) {
      setShopAttemptDays(null);
      return;
    }
    let alive = true;
    setShopAttemptDays(null);
    setShopAttemptDaysRange(null);
    setShopAttemptBlockedSpikes([]);
    fetchPublicShopOrderAttemptDays(shopAttemptFrom, shopAttemptTo)
      .then(({ days, blockedSpikes }) => {
        if (alive) {
          setShopAttemptDays(days);
          setShopAttemptBlockedSpikes(blockedSpikes);
          setShopAttemptDaysRange(`${shopAttemptFrom}:${shopAttemptTo}`);
        }
      })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : "Could not load public shop request activity."); });
    return () => { alive = false; };
  }, [mode, shopAttemptFrom, shopAttemptTo, reload]);
  async function downloadShopAttemptDaysCsv() {
    if (!shopAttemptDaysForCurrentRange || !shopAttemptFrom || !shopAttemptTo || shopAttemptFrom > shopAttemptTo) return;
    try {
      setError("");
      const csv = await fetchPublicShopOrderAttemptCsv(shopAttemptFrom, shopAttemptTo);
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `public-shop-daily-totals-${shopAttemptFrom}-to-${shopAttemptTo}.csv`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not export public shop request activity.");
    }
  }
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
    const lines = order.lines.map((line) => {
      const locationAllocations = reservedDeliveryLocations(line).map((location) => ({
        locationId: location.locationId,
        quantity: Number(form.get(`location-${line.id}-${location.locationId}`) || 0),
      })).filter((allocation) => allocation.quantity > 0);
      return {
        salesOrderLineId: line.id,
        quantity: Number(form.get(`quantity-${line.id}`) || 0),
        ...(locationAllocations.length ? { locationAllocations } : {}),
      };
    }).filter((line) => line.quantity > 0);
    if (!lines.length) { setError("Enter a quantity for at least one item."); return; }
    if (lines.some((line) => line.locationAllocations
      && line.locationAllocations.reduce((total, allocation) => total + allocation.quantity, 0) !== line.quantity)) {
      setError("For each custom location split, assigned quantities must equal the delivery quantity.");
      return;
    }
    setError(""); setNotice("");
    setDeliverySubmitting(true);
    try {
      await createSalesDelivery(order.id, {
        idempotencyKey: String(form.get("idempotencyKey")),
        deliveryDate: String(form.get("deliveryDate")),
        lines: lines.map((line) => ({
          ...line,
          locationAllocations: line.locationAllocations ?? [],
        })),
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
  async function emailDeliveryInvoice(delivery: SalesDelivery) {
    if (deliveryInvoiceSendingId !== null) return;
    const latest = delivery.invoiceEmailAttempts?.[0];
    const staleSending = latest?.status === "sending"
      && Date.now() - new Date(latest.attemptedAt).getTime() > 5 * 60 * 1000;
    const options: { confirmAmbiguousRetry?: boolean; confirmResend?: boolean } = {};
    if (latest?.status === "sending" || latest?.status === "ambiguous") {
      if (!staleSending && latest.status === "sending") return;
      if (!window.confirm(
        `The previous invoice email may have reached ${latest.recipientEmail}. Check Gmail Sent first. If it is not there, retry ${delivery.deliveryNumber}?`,
      )) return;
      options.confirmAmbiguousRetry = true;
    } else if (latest?.status === "sent") {
      if (!window.confirm(`Invoice ${delivery.deliveryNumber} was already emailed to ${latest.recipientEmail}. Send it again?`)) return;
      options.confirmResend = true;
    }
    setDeliveryInvoiceSendingId(delivery.id);
    setDeliveryInvoiceFeedback((current) => ({ ...current, [delivery.id]: { kind: "success", message: "Sending invoice…" } }));
    try {
      const message = await sendSalesDeliveryInvoice(delivery.id, options);
      setDeliveryInvoiceFeedback((current) => ({ ...current, [delivery.id]: { kind: "success", message } }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not send the delivery invoice.";
      setDeliveryInvoiceFeedback((current) => ({ ...current, [delivery.id]: { kind: "error", message } }));
    } finally {
      setDeliveryInvoiceSendingId((current) => current === delivery.id ? null : current);
      setReload((value) => value + 1);
    }
  }
  async function submitReceipt(event: FormEvent<HTMLFormElement>, delivery: SalesDelivery) {
    event.preventDefault();
    if (receiptSubmitting) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const uploads = receiptProofUploads.filter(({ file }) => file.size > 0);
    const preparedUploads = uploads.map((upload) => upload.file.size > 5 * 1024 * 1024
      ? { ...upload, status: "failed" as const, error: "Each signed proof file must be 5 MB or smaller." }
      : upload);
    const oversizedKeys = new Set(preparedUploads
      .filter((upload) => upload.file.size > 5 * 1024 * 1024)
      .map((upload) => upload.idempotencyKey));
    const validUploads = preparedUploads.filter((upload) => !oversizedKeys.has(upload.idempotencyKey));
    setReceiptProofUploads(preparedUploads);
    const receivedAtValue = String(form.get("receivedAt") || "");
    const receivedAt = new Date(receivedAtValue);
    if (!Number.isFinite(receivedAt.getTime())) {
      setError("Enter a valid date and time the delivery was received.");
      return;
    }
    setError(""); setNotice(""); setReceiptSubmitting(true);
    let savedReceipt: Awaited<ReturnType<typeof saveSalesDeliveryReceipt>> | null = null;
    const savedProofs = [...(delivery.receipt?.proofs ?? [])];
    try {
      savedReceipt = await saveSalesDeliveryReceipt(delivery.id, {
        receivedBy: String(form.get("receivedBy") || "").trim(),
        receivedAt: receivedAt.toISOString(),
      });
      const result = await processDeliveryProofUploads(
        validUploads,
        async (upload) => {
          const proof = await addSalesDeliveryReceiptProof(delivery.id, upload.file, upload.idempotencyKey);
          clearSalesProofRetryKey(window.sessionStorage, delivery.id, upload.file);
          if (!savedProofs.some((saved) => saved.id === proof.id)) savedProofs.push(proof);
          setReceiptDelivery((current) => current?.delivery.id === delivery.id
            ? { ...current, delivery: { ...current.delivery, receipt: { ...savedReceipt!, proofs: [...savedProofs] } } }
            : current);
          return proof;
        },
        (progress) => {
          const progressByKey = new Map(progress.map((upload) => [upload.idempotencyKey, upload]));
          setReceiptProofUploads((current) => current.map((upload) => progressByKey.get(upload.idempotencyKey) ?? upload));
        },
      );
      const progressByKey = new Map(result.uploads.map((upload) => [upload.idempotencyKey, upload]));
      const finalUploads = preparedUploads.map((upload) => progressByKey.get(upload.idempotencyKey) ?? upload);
      setReceiptProofUploads(finalUploads);
      if (result.failed.length || finalUploads.some((upload) => upload.status === "failed")) {
        const failedFiles = finalUploads.filter((upload) => upload.status === "failed");
        const failureDetails = failedFiles.map((upload) => `${upload.file.name}: ${upload.error}`).join(" ");
        setError(`Receipt details were saved. ${savedProofs.length} proof file(s) are attached; ${failedFiles.length} file(s) need attention. ${failureDetails} Save again to retry only unfinished files.`);
        return;
      }
      setReceiptProofUploads([]);
      setReceiptDelivery(null);
      setNotice("Delivery receipt saved.");
      setReload((value) => value + 1);
    } catch (cause) {
      if (savedReceipt) {
        setReceiptDelivery((current) => current?.delivery.id === delivery.id
          ? { ...current, delivery: { ...current.delivery, receipt: { ...savedReceipt!, proofs: [...savedProofs] } } }
          : current);
        const detail = cause instanceof Error ? cause.message : "Could not save the delivery receipt.";
        setError(`Could not save the delivery receipt details. ${detail} Any selected proof files remain available to retry.`);
      } else {
        setError(cause instanceof Error ? cause.message : "Could not save the delivery receipt.");
      }
    } finally {
      setReceiptSubmitting(false);
    }
  }
  async function submitReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!returnForm || returnSubmitting) return;
    const form = new FormData(event.currentTarget);
    setError(""); setNotice(""); setReturnSubmitting(true);
    try {
      await recordSalesReturn(returnForm.line.salesDeliveryLineId, {
        idempotencyKey: returnForm.idempotencyKey,
        locationId: Number(form.get("locationId")),
        quantity: Number(form.get("quantity")),
        returnDate: String(form.get("returnDate")),
        reason: String(form.get("reason") || "").trim(),
      });
      setReturnForm(null);
      setNotice("Return recorded. Stock, customer balance, and accounting records have been updated.");
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record this customer return.");
    } finally {
      setReturnSubmitting(false);
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
  const shopAttemptDaysForCurrentRange = shopAttemptDaysRange === `${shopAttemptFrom}:${shopAttemptTo}` ? shopAttemptDays : null;
  const shopAttemptRangeTotals = (shopAttemptDaysForCurrentRange ?? []).reduce(
    (totals, day) => ({
      accepted: totals.accepted + day.accepted,
      blocked: totals.blocked + day.blocked,
      rateLimited: totals.rateLimited + day.rateLimited,
      botCheck: totals.botCheck + day.botCheck,
      unclassifiedBlocked: totals.unclassifiedBlocked + day.unclassifiedBlocked,
    }),
    { accepted: 0, blocked: 0, rateLimited: 0, botCheck: 0, unclassifiedBlocked: 0 },
  );
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
        if (historyCustomer && !matchesCustomer(historyCustomer, value)) {
          setHistoryCustomer(null);
          setPurchaseHistorySearch("");
          setPurchaseHistoryVisibleCount(25);
        }
      }} /></label>
      <div className="panel data-table-wrap"><table><thead><tr><th>Customer</th><th>Customer ID</th><th /></tr></thead><tbody>{filteredCustomers.map((c) => <tr key={c.id}><td>{c.name}</td><td>{customerCode(c.id)}</td><td><button className="button button-secondary button-small" onClick={() => {
        const closing = historyCustomer?.id === c.id;
        setHistoryCustomer(closing ? null : c);
        setPurchaseHistorySearch("");
        setPurchaseHistoryVisibleCount(25);
      }}>{historyCustomer?.id === c.id ? "Close customer" : "View customer"}</button></td></tr>)}</tbody></table>{!filteredCustomers.length && <p className="report-footnote">No customers match that name or ID.</p>}</div>
      {historyCustomer && filteredCustomers.some((item) => item.id === historyCustomer.id) && (() => {
        const customer = customers.find((item) => item.id === historyCustomer.id) ?? historyCustomer;
        const purchases = orders
          .filter((order) => order.customerId === customer.id && Number(order.deliveredZmw) > 0)
          .sort((a, b) => b.orderDate.localeCompare(a.orderDate));
        const { matching: matchingPurchases, visible: visiblePurchases, hasMore } =
          pageCustomerPurchaseHistory(purchases, purchaseHistorySearch, purchaseHistoryVisibleCount);
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
          <label>Find a purchase by order, delivery note, or date<input
            type="search"
            placeholder="Order number, delivery note, or date"
            value={purchaseHistorySearch}
            onChange={(event) => {
              setPurchaseHistorySearch(event.target.value);
              setPurchaseHistoryVisibleCount(25);
            }}
          /></label>
          <p className="report-footnote">Showing {visiblePurchases.length} of {matchingPurchases.length} matching purchase(s).</p>
          <table><thead><tr><th>Order</th><th>Order date</th><th>Items delivered</th><th>Delivered value</th><th>Delivery notes and proof</th><th>Status</th></tr></thead>
            <tbody>{visiblePurchases.map((order) => <tr key={order.id}>
              <td>{order.orderNumber}</td><td>{new Date(order.orderDate).toLocaleDateString("en-ZM")}</td>
              <td>{order.lines.filter((line) => line.deliveredQuantity > 0).map((line) => `${line.productName} × ${line.deliveredQuantity}`).join(", ")}</td>
              <td>{zmw(order.deliveredZmw)}</td>
              <td>{order.deliveries.length ? order.deliveries.map((delivery) => <div key={delivery.id} className="delivery-actions">
                <button
                  type="button"
                  className="button button-secondary button-small"
                  onClick={() => setDeliveryPrint({ order, delivery })}
                >{delivery.deliveryNumber}</button>
                {delivery.receipt ? <div>
                  <span><strong>Received by:</strong> {delivery.receipt.receivedBy}</span>
                  <small>{new Date(delivery.receipt.receivedAt).toLocaleString("en-ZM", { dateStyle: "medium", timeStyle: "short" })}</small>
                  {!!delivery.receipt.proofs.length && <ul>
                    {delivery.receipt.proofs.map((proof, index) => <li key={proof.id ?? `legacy-${index}`}>
                      <a
                        href={proof.id === null
                          ? salesDeliveryReceiptProofUrl(delivery.id)
                          : salesDeliveryReceiptProofFileUrl(delivery.id, proof.id)}
                        target="_blank"
                        rel="noreferrer"
                      >{proof.fileName}</a>
                    </li>)}
                  </ul>}
                </div> : <small>No receipt details saved.</small>}
              </div>) : order.status === "fulfilled" ? <button
                type="button"
                className="button button-secondary button-small"
                onClick={() => setDeliveryPrint({ order, delivery: null })}
              >Delivery note</button> : <span>No delivery note recorded.</span>}</td>
              <td>{order.status.replace("_", " ")}</td>
            </tr>)}</tbody>
          </table>
          {!purchases.length
            ? <p className="report-footnote">This customer has no delivered purchases yet.</p>
            : !matchingPurchases.length && <p className="report-footnote">No delivered purchases match “{purchaseHistorySearch}”. Try an order number, delivery note number, or date.</p>}
          {hasMore && <button
            type="button"
            className="button button-secondary button-small"
            onClick={() => setPurchaseHistoryVisibleCount((current) => current + 25)}
          >Load 25 more purchases</button>}
        </div>;
      })()}
    </>}
    {mode === "orders" && <>
      <section className="panel" aria-labelledby="public-shop-attempts-heading">
        <div className="panel-heading"><div><h2 id="public-shop-attempts-heading">Public shop order requests</h2><p>Lifetime totals. Blocked counts include requests stopped by the shop’s anti-abuse checks.</p></div></div>
        <div className="metric-grid">
          <article className="metric-card"><div className="metric-top"><span>Accepted requests</span></div><strong className="metric-value">{shopAttemptSummary?.accepted ?? "—"}</strong></article>
          <article className="metric-card"><div className="metric-top"><span>Blocked requests</span></div><strong className="metric-value">{shopAttemptSummary?.blocked ?? "—"}</strong></article>
          <article className="metric-card"><div className="metric-top"><span>Rate-limited</span></div><strong className="metric-value">{shopAttemptSummary?.rateLimited ?? "—"}</strong></article>
          <article className="metric-card"><div className="metric-top"><span>Challenge or honeypot failed</span></div><strong className="metric-value">{shopAttemptSummary?.botCheck ?? "—"}</strong></article>
          <article className="metric-card"><div className="metric-top"><span>Reason not recorded</span></div><strong className="metric-value">{shopAttemptSummary?.unclassifiedBlocked ?? "—"}</strong></article>
        </div>
        <p className="report-footnote">Only aggregate counts are included in this report; rejected visitor details are not collected or exposed here. Reason tracking starts with this update. Older blocked requests appear under “Reason not recorded.”</p>
        <h3>Daily request activity</h3>
        <p className="report-footnote">Choose a date range to see accepted and blocked requests per day. Dates use UTC. A warning appears when more than 25 requests are blocked on a UTC day.</p>
        <div className="form-grid">
          <label>From date<input type="date" value={shopAttemptFrom} max={shopAttemptTo || undefined} onChange={(event) => setShopAttemptFrom(event.target.value)} /></label>
          <label>Through date<input type="date" value={shopAttemptTo} min={shopAttemptFrom || undefined} onChange={(event) => setShopAttemptTo(event.target.value)} /></label>
          {shopAttemptDaysForCurrentRange && shopAttemptFrom <= shopAttemptTo && <button type="button" className="button button-secondary" onClick={downloadShopAttemptDaysCsv}>Download daily totals CSV</button>}
        </div>
        {shopAttemptDaysForCurrentRange && <div className="metric-grid">
          <article className="metric-card"><div className="metric-top"><span>Accepted in selected dates</span></div><strong className="metric-value">{shopAttemptRangeTotals.accepted}</strong></article>
          <article className="metric-card"><div className="metric-top"><span>Blocked in selected dates</span></div><strong className="metric-value">{shopAttemptRangeTotals.blocked}</strong></article>
          <article className="metric-card"><div className="metric-top"><span>Rate-limited in selected dates</span></div><strong className="metric-value">{shopAttemptRangeTotals.rateLimited}</strong></article>
          <article className="metric-card"><div className="metric-top"><span>Challenge or honeypot failed</span></div><strong className="metric-value">{shopAttemptRangeTotals.botCheck}</strong></article>
          <article className="metric-card"><div className="metric-top"><span>Reason not recorded in selected dates</span></div><strong className="metric-value">{shopAttemptRangeTotals.unclassifiedBlocked}</strong></article>
        </div>}
        {shopAttemptDaysForCurrentRange && shopAttemptBlockedSpikes.length > 0 && <div className="notice-strip" role="alert">
          <strong>High blocked-request activity</strong>
          <ul>{shopAttemptBlockedSpikes.map(({ day, blocked }) => <li key={day}>
            {new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-ZM", { timeZone: "UTC", dateStyle: "medium" })}: {blocked} requests were blocked, above the warning threshold of 25 per day.
          </li>)}</ul>
          <p>These warnings use daily aggregate counts only; visitor identities are not recorded.</p>
        </div>}
        {!shopAttemptFrom || !shopAttemptTo || shopAttemptFrom > shopAttemptTo
          ? <p role="alert">Choose a valid range with the start date on or before the end date.</p>
          : shopAttemptDaysForCurrentRange === null
            ? <p className="report-footnote">Loading daily requests…</p>
            : <div className="data-table-wrap">
              <table>
                <thead><tr><th>Date (UTC)</th><th>Accepted</th><th>Blocked</th><th>Rate-limited</th><th>Challenge or honeypot failed</th><th>Reason not recorded</th></tr></thead>
                <tbody>{shopAttemptDaysForCurrentRange.map((day) => <tr key={day.day}>
                  <td>{new Date(`${day.day}T00:00:00.000Z`).toLocaleDateString("en-ZM", { timeZone: "UTC", dateStyle: "medium" })}</td>
                  <td>{day.accepted}</td>
                  <td>{day.blocked}</td>
                  <td>{day.rateLimited}</td>
                  <td>{day.botCheck}</td>
                  <td>{day.unclassifiedBlocked}</td>
                </tr>)}</tbody>
              </table>
            </div>}
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
            const suggested = suggestedStockAllocations(line);
            const suggestedLabel = suggested.length
              ? suggested.map((allocation) => `${allocation.name} × ${allocation.quantity}`).join(" + ")
              : "not enough combined stock";
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
                <option value="auto">Auto · {suggestedLabel}</option>
                {line.stockLocations.map((location) => <option key={location.id} value={location.id} disabled={location.available < line.quantity}>
                  {location.name} · {location.available} available
                </option>)}
              </select> : <div className="sales-stock-reservations">
                {line.stockReservations.length ? line.stockReservations.map((reservation) => (
                  <small key={reservation.id}>
                    {reservation.locationName || "Stock"} · {reservation.quantity} · {reservation.status}
                  </small>
                )) : <span>{line.stockLocationName || "Not reserved"}</span>}
              </div>}
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
              <div className="sales-delivery-stock-history">
                {delivery.lines.map((line) => <small key={line.salesDeliveryLineId}>
                  {line.productName} × {line.quantity} · {line.stockLocations.length
                    ? line.stockLocations.map((location) => `${location.locationName || "Stock"} × ${location.quantity}`).join(", ")
                    : "location history unavailable"}
                </small>)}
              </div>
            </span>)}
            {o.deliveries.map((delivery) => <div key={`invoice-${delivery.id}`} className="delivery-actions">
              {delivery.invoiceEmailAttempts?.[0] && <small className="invoice-email-history-summary">
                {delivery.invoiceEmailAttempts.length} email attempt{delivery.invoiceEmailAttempts.length === 1 ? "" : "s"} · latest {delivery.invoiceEmailAttempts[0].status}
                {delivery.invoiceEmailAttempts[0].recipientEmail ? ` to ${delivery.invoiceEmailAttempts[0].recipientEmail}` : ""}
                {delivery.invoiceEmailAttempts[0].attemptedAt ? ` · ${new Date(delivery.invoiceEmailAttempts[0].attemptedAt).toLocaleString("en-ZM")}` : ""}
                {delivery.invoiceEmailAttempts[0].providerMessageId ? ` · Gmail reference ${delivery.invoiceEmailAttempts[0].providerMessageId}` : ""}
                {delivery.invoiceEmailAttempts[0].error ? ` · ${delivery.invoiceEmailAttempts[0].error}` : ""}
                {delivery.invoiceEmailAttempts.length > 1 && <details>
                  <summary>Show invoice email history</summary>
                  <ol>{delivery.invoiceEmailAttempts.map((attempt) => <li key={attempt.id}>
                    Attempt {attempt.attemptNumber}: {attempt.status} · {attempt.recipientEmail} · {new Date(attempt.attemptedAt).toLocaleString("en-ZM")}
                    {attempt.providerMessageId ? ` · Gmail reference ${attempt.providerMessageId}` : ""}
                    {attempt.error ? ` · ${attempt.error}` : ""}
                  </li>)}</ol>
                </details>}
              </small>}
              <button className="button button-secondary button-small" onClick={() => setInvoicePrint({ order: o, delivery })}>
                Invoice {delivery.deliveryNumber} / PDF
              </button>
              <button
                className="button button-secondary button-small"
                disabled={deliveryInvoiceSendingId !== null || (delivery.invoiceEmailAttempts?.[0]?.status === "sending"
                  && Date.now() - new Date(delivery.invoiceEmailAttempts[0].attemptedAt).getTime() <= 5 * 60 * 1000)}
                onClick={() => emailDeliveryInvoice(delivery)}
                aria-label={`Email invoice for ${delivery.deliveryNumber} to ${customers.find((customer) => customer.id === o.customerId)?.email || "the customer's saved email address"}`}
              >
                {deliveryInvoiceSendingId === delivery.id ? "Sending invoice…" : delivery.invoiceEmailAttempts?.[0]?.status === "sending" || delivery.invoiceEmailAttempts?.[0]?.status === "ambiguous" ? "Check Gmail & retry" : "Email invoice"}
              </button>
              {deliveryInvoiceFeedback[delivery.id] && <small
                className={deliveryInvoiceFeedback[delivery.id]!.kind === "error" ? "order-action-error" : ""}
                role={deliveryInvoiceFeedback[delivery.id]!.kind === "error" ? "alert" : "status"}
              >{deliveryInvoiceFeedback[delivery.id]!.message}</small>}
            </div>)}
            {o.deliveries.map((delivery) => <div key={`returns-${delivery.id}`} className="delivery-return-list">
              <strong>Returns · {delivery.deliveryNumber}</strong>
              {delivery.lines.map((line) => <div key={line.salesDeliveryLineId}>
                <span>{line.productName} · delivered {line.quantity} · returned {line.returnedQuantity}</span>
                {line.returns.map((item, index) => <small key={`${line.salesDeliveryLineId}-${index}`}>
                  {item.quantity} to {item.locationName || "stock"} · {item.reason}
                </small>)}
                {line.returnedQuantity < line.quantity && <button
                  className="button button-secondary button-small"
                  onClick={() => setReturnForm({ order: o, delivery, line, idempotencyKey: window.crypto.randomUUID() })}
                >Record return</button>}
              </div>)}
            </div>)}
            {o.status === "fulfilled" && <button className="button button-secondary button-small" onClick={() => setInvoicePrint({ order: o, delivery: null })}>Order invoice / PDF</button>}
           {o.status === "fulfilled" && !o.deliveries.length && <button className="button button-secondary button-small" onClick={() => setDeliveryPrint({ order: o, delivery: null })}>Delivery note</button>}
          {orderActionErrors[o.id] && <small className="order-action-error" role="alert">{orderActionErrors[o.id]}</small>}
        </td></tr>)}</tbody></table></div>
    </>}
    {mode === "orders" && deliveryFormOrder && <div className="modal-backdrop" role="presentation">
      <form className="modal form-grid delivery-entry-form" onSubmit={(event) => submitDelivery(event, deliveryFormOrder)}>
        <h2>Record delivery · {deliveryFormOrder.orderNumber}</h2>
        <input type="hidden" name="idempotencyKey" value={deliveryRequestKey} />
        <label>Delivery date<input type="date" name="deliveryDate" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
        {deliveryFormOrder.lines.filter((line) => line.remainingQuantity > 0).map((line) => {
          const reservedLocations = reservedDeliveryLocations(line);
          return <div key={line.id} className="delivery-line-allocation">
            <label>
              {line.productName} · {line.sku} · {line.remainingQuantity} remaining
              <input type="number" name={`quantity-${line.id}`} min="0" max={line.remainingQuantity} defaultValue="0" />
            </label>
            {reservedLocations.length > 0 && <fieldset>
              <legend>Choose quantities by reserved location (optional)</legend>
              <p className="report-footnote">Leave all at 0 to use the usual reservation order. A custom split must add up to the delivery quantity.</p>
              {reservedLocations.map((location) => <label key={location.locationId}>
                {location.locationName} · {location.quantity} reserved
                <input
                  type="number"
                  name={`location-${line.id}-${location.locationId}`}
                  min="0"
                  max={location.quantity}
                  defaultValue="0"
                />
              </label>)}
            </fieldset>}
          </div>;
        })}
        <div className="modal-footer-actions"><button type="button" className="button button-secondary" disabled={deliverySubmitting} onClick={() => setDeliveryFormOrder(null)}>Cancel</button><button className="button button-primary" disabled={deliverySubmitting}>{deliverySubmitting ? "Saving…" : "Save delivery"}</button></div>
      </form>
    </div>}
    {mode === "orders" && receiptDelivery && <div className="modal-backdrop" role="presentation">
      <form className="modal form-grid delivery-entry-form" onSubmit={(event) => submitReceipt(event, receiptDelivery.delivery)}>
        <h2>Delivery receipt · {receiptDelivery.delivery.deliveryNumber}</h2>
        <p>{receiptDelivery.order.customerName} · {receiptDelivery.order.orderNumber}</p>
        <label>Received by<input name="receivedBy" required maxLength={120} defaultValue={receiptDelivery.delivery.receipt?.receivedBy ?? ""} /></label>
        <label>Date and time received<input name="receivedAt" type="datetime-local" required defaultValue={localDateTime(receiptDelivery.delivery.receipt?.receivedAt)} /></label>
        <label>Signed proof files (PDF or image, up to 5 MB each)
          <input name="proofFiles" type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => {
            try {
              setError("");
              setReceiptProofUploads(Array.from(event.currentTarget.files ?? []).map((file) => ({
                file,
                idempotencyKey: getSalesProofRetryKey(
                  window.sessionStorage, receiptDelivery.delivery.id, file, () => window.crypto.randomUUID(),
                ),
                status: "pending",
              })));
            } catch {
              setError("This browser could not save a safe retry key for the proof upload. Check storage settings and select the file again.");
            }
          }} disabled={receiptSubmitting} />
        </label>
        {!!receiptProofUploads.length && <ul className="proof-upload-progress" aria-live="polite" aria-label="Signed proof upload progress">
          {receiptProofUploads.map((upload) => <li key={upload.idempotencyKey}>
            <strong>{upload.file.name}</strong>
            <span>{upload.status === "pending" ? "Waiting" : upload.status === "uploading" ? "Uploading…" : upload.status === "saved" ? "Saved" : `Failed${upload.error ? `: ${upload.error}` : ""}`}</span>
          </li>)}
        </ul>}
        {!!receiptDelivery.delivery.receipt?.proofs.length && <div>
          <strong>Saved signed proof files</strong>
          <ul>{receiptDelivery.delivery.receipt.proofs.map((proof, index) => <li key={proof.id ?? `legacy-${index}`}>
            <a
              href={proof.id === null
                ? salesDeliveryReceiptProofUrl(receiptDelivery.delivery.id)
                : salesDeliveryReceiptProofFileUrl(receiptDelivery.delivery.id, proof.id)}
              target="_blank" rel="noreferrer"
            >{proof.fileName}</a>
          </li>)}</ul>
        </div>}
        <p className="report-footnote">Receipt details and signed proof are stored with this delivery note, separately from invoices and payments.</p>
        <div className="modal-footer-actions">
          <button type="button" className="button button-secondary" disabled={receiptSubmitting} onClick={() => {
            setReceiptProofUploads([]);
            setReceiptDelivery(null);
          }}>Cancel</button>
          <button className="button button-primary" disabled={receiptSubmitting}>{receiptSubmitting ? "Saving…" : "Save receipt"}</button>
        </div>
      </form>
    </div>}
    {mode === "orders" && returnForm && <div className="modal-backdrop" role="presentation">
      <form className="modal form-grid delivery-entry-form" onSubmit={submitReturn}>
        <h2>Return item · {returnForm.delivery.deliveryNumber}</h2>
        <p>{returnForm.order.customerName} · {returnForm.order.orderNumber}</p>
        <p><strong>{returnForm.line.productName} · {returnForm.line.sku}</strong></p>
        <p>Delivered: {returnForm.line.quantity} · Already returned: {returnForm.line.returnedQuantity}</p>
        <label>Return to location<select name="locationId" required defaultValue="">
          <option value="">Choose location</option>
          {inventoryLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
        </select></label>
        <label>Quantity<input name="quantity" type="number" min="1" max={returnForm.line.quantity - returnForm.line.returnedQuantity} step="1" required defaultValue="1" /></label>
        <label>Return date<input name="returnDate" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></label>
        <label>Reason<input name="reason" minLength={3} maxLength={500} required placeholder="For example, item returned unused" /></label>
        <p className="report-footnote">This return will increase stock at the selected location, reduce the customer balance, and reverse the related inventory cost.</p>
        <div className="modal-footer-actions">
          <button type="button" className="button button-secondary" disabled={returnSubmitting} onClick={() => setReturnForm(null)}>Cancel</button>
          <button className="button button-primary" disabled={returnSubmitting || !inventoryLocations.length}>{returnSubmitting ? "Saving…" : "Save return"}</button>
        </div>
      </form>
    </div>}
    {mode === "orders" && invoicePrint && (() => {
      const { order, delivery } = invoicePrint;
      const customer = customers.find((item) => item.id === order.customerId);
      const invoice = salesInvoiceDocument(order, delivery);
      return <div className="quote-preview-overlay" role="dialog" aria-modal="true" aria-labelledby="invoice-preview-title">
        <div className="quote-preview-panel">
          <div className="quote-preview-toolbar">
            <div><strong id="invoice-preview-title">Invoice preview</strong><span>Choose “Save as PDF” in the print window.</span></div>
            <div><button className="button button-primary" onClick={() => window.print()}>Print / Save PDF</button><button className="button button-secondary" onClick={() => setInvoicePrint(null)}>Close</button></div>
          </div>
          <article className="customer-quote-document" id="sales-invoice-print">
            <header className="customer-quote-document-header">
              <div className="customer-quote-document-brand"><img src={companyLogo} alt={`${companyName} logo`} /><div><strong>{companyName}</strong><small>{companyAddress}<br />{companyEmail}<br />{companyPhone}</small></div></div>
              <div className="customer-quote-document-title">
                <div><span className="customer-quote-document-kicker">{delivery ? "DELIVERY INVOICE" : "SALES INVOICE"}</span><h1>{invoice.invoiceRef}</h1></div>
                <div className="customer-quote-document-meta">
                  <div><span>Invoice date</span><strong>{documentDate(invoice.date)}</strong></div>
                  <div><span>Sales order</span><strong>{order.orderNumber}</strong></div>
                  {delivery && <div><span>Delivery</span><strong>{delivery.deliveryNumber}</strong></div>}
                </div>
              </div>
            </header>
            <section className="customer-quote-document-customer">
              <span>INVOICE FOR</span><strong>{order.customerName}</strong>
              {customer?.email && <p>{customer.email}</p>}
              {customer?.phone && <p>{customer.phone}</p>}
              {customer?.address && <p><b>Billing address:</b> {customer.address}</p>}
              {order.deliveryAddress && <p><b>Delivery address:</b> {order.deliveryAddress}</p>}
            </section>
            <table className="customer-quote-document-table">
              <thead><tr><th>Product</th><th>SKU</th><th className="quote-number-cell">Qty</th><th className="quote-number-cell">Unit price</th><th className="quote-number-cell">Amount</th></tr></thead>
              <tbody>{invoice.lines.map((line) => <tr key={line.id}>
                <td>{line.productName}</td><td>{line.sku}</td><td className="quote-number-cell">{line.quantity}</td><td className="quote-number-cell">{zmw(line.unitPriceZmw)}</td><td className="quote-number-cell">{zmw(line.lineTotalZmw)}</td>
              </tr>)}</tbody>
            </table>
            <div className="customer-quote-document-total"><span>Total (ZMW)</span><strong>{zmw(invoice.totalZmw)}</strong></div>
            {order.notes && <section className="customer-quote-document-notes"><span>NOTES</span><p>{order.notes}</p></section>}
            <footer className="customer-quote-document-footer">All prices are in ZMW. Invoice reference: {invoice.invoiceRef} · Sales order: {order.orderNumber}{delivery ? ` · Delivery: ${delivery.deliveryNumber}` : ""}</footer>
          </article>
        </div>
      </div>;
    })()}
    {deliveryPrint && (() => {
      const { order, delivery } = deliveryPrint;
      const customer = customers.find((item) => item.id === order.customerId);
      const noteRef = delivery?.deliveryNumber ?? deliveryNoteNumber(order);
      const noteLines = delivery
        ? delivery.lines.map((line) => ({ ...line }))
        : order.lines.map((line) => ({
          salesOrderLineId: line.id, productName: line.productName, sku: line.sku, quantity: line.quantity,
          stockLocations: [],
        }));
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
                <td>
                  <strong>{line.productName}</strong>
                  <small className="delivery-note-locations">Shipped from: {describeDeliveryNoteLocations(line.stockLocations)}</small>
                </td>
                <td>{line.sku}</td><td className="quote-number-cell">{line.quantity}</td>
              </tr>)}</tbody>
            </table>
            {order.notes && <section className="customer-quote-document-notes"><span>ORDER NOTES</span><p>{order.notes}</p></section>}
            <section className="delivery-note-signatures" aria-label="Delivery confirmation">
              <div><span>Delivered by</span><span>Name and signature</span><span>Date</span></div>
              {delivery?.receipt
                ? <div><span>Received by</span><strong>{delivery.receipt.receivedBy}</strong><span>{new Date(delivery.receipt.receivedAt).toLocaleString("en-ZM", { dateStyle: "medium", timeStyle: "short" })}</span></div>
                : <div><span>Received by</span><span>Name and signature</span><span>Date</span></div>}
            </section>
            {!!delivery?.receipt?.proofs.length && <section className="customer-quote-document-notes">
              <span>SIGNED DELIVERY PROOF</span>
              <ul>{delivery.receipt.proofs.map((proof, index) => <li key={proof.id ?? `legacy-${index}`}>
                <a
                  href={proof.id === null
                    ? salesDeliveryReceiptProofUrl(delivery.id)
                    : salesDeliveryReceiptProofFileUrl(delivery.id, proof.id)}
                  target="_blank" rel="noreferrer"
                >{proof.fileName}</a>
              </li>)}</ul>
            </section>}
            <footer className="customer-quote-document-footer">Please check the items and quantities above when receiving this delivery. This note does not serve as an invoice or payment receipt.</footer>
          </article>
        </div>
      </div>;
    })()}
  </section>;
}
