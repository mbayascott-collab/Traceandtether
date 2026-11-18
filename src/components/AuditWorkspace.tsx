import { useEffect, useState } from "react";

type AuditEntry = {
  id: number;
  entityType: string;
  entityId: number;
  recordLabel: string;
  actorEmail: string;
  action: "created" | "updated" | "deleted" | string;
  changedFields: string[];
  createdAt: string;
};

const categories = [
  ["all", "All changes"],
  ["product", "Products"],
  ["category", "Categories"],
  ["supplier", "Suppliers"],
  ["supplier_quote", "Supplier quotes"],
  ["customer", "Customers"],
  ["sales_order", "Sales orders"],
  ["customer_quote", "Customer quotes"],
  ["sales_delivery", "Deliveries"],
  ["inventory_movement", "Stock movements"],
  ["inventory_reservation", "Reservations"],
  ["inventory_location", "Stock locations"],
  ["purchase_order", "Purchase orders"],
  ["shipment", "Shipments"],
  ["import_expense", "Import expenses"],
  ["business_expense", "Business expenses"],
  ["journal_entry", "Accounting entries"],
  ["payment", "Payments"],
  ["payment_statement_line", "Bank statement lines"],
  ["landed_cost_adjustment", "Landed-cost adjustments"],
  ["marketing_campaign", "Marketing campaigns"],
  ["marketing_content", "Marketing content"],
  ["marketing_expense", "Marketing expenses"],
  ["marketing_customer_group", "Customer groups"],
];

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

export default function AuditWorkspace() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    const query = filter === "all" ? "" : `?entityType=${encodeURIComponent(filter)}`;
    fetch(`/api/audit-logs${query}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not load change history.");
        return body as { entries: AuditEntry[] };
      })
      .then((body) => {
        if (alive) setEntries(body.entries);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : "Could not load change history.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [filter]);

  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Workspace records</p>
          <h1>Change history</h1>
          <p>See which account created, updated, or removed business records and when.</p>
        </div>
        <label className="audit-filter">
          <span>Record type</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            {categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </header>
      {error && <div className="notice-strip audit-error" role="alert">{error}</div>}
      <section className="panel data-table-wrap">
        <p className="report-footnote">Showing up to 250 recent changes.</p>
        {loading ? <p role="status">Loading change history…</p> : (
          <table>
            <thead><tr><th>Date and time</th><th>Record</th><th>Change</th><th>Account</th><th>Fields</th></tr></thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{new Date(entry.createdAt).toLocaleString()}</td>
                  <td>{entry.recordLabel}<span className="product-secondary">{humanize(entry.entityType)} · #{entry.entityId}</span></td>
                  <td>{humanize(entry.action)}</td>
                  <td>{entry.actorEmail}</td>
                  <td>{entry.changedFields.length ? entry.changedFields.map(humanize).join(", ") : "—"}</td>
                </tr>
              ))}
              {!entries.length && <tr><td colSpan={5}>No changes found for this record type.</td></tr>}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
