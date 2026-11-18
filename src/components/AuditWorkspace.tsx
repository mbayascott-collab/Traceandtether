import { type FormEvent, useEffect, useState } from "react";

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
  const [filters, setFilters] = useState({ entityType: "", actor: "", from: "", to: "" });
  const [draft, setDraft] = useState(filters);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 50, total: 0, totalPages: 1 });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ page: String(page), pageSize: String(pagination.pageSize) });
    if (filters.entityType) query.set("entityType", filters.entityType);
    if (filters.actor) query.set("actor", filters.actor);
    if (filters.from) query.set("from", filters.from);
    if (filters.to) query.set("to", filters.to);
    fetch(`/api/audit-logs?${query.toString()}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not load change history.");
        return body as {
          entries: AuditEntry[];
          pagination: { page: number; pageSize: number; total: number; totalPages: number };
        };
      })
      .then((body) => {
        if (alive) {
          setEntries(body.entries);
          setPagination(body.pagination);
        }
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : "Could not load change history.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [filters, page, pagination.pageSize]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilters({ ...draft, actor: draft.actor.trim() });
    setPage(1);
  }

  function clearFilters() {
    const empty = { entityType: "", actor: "", from: "", to: "" };
    setDraft(empty);
    setFilters(empty);
    setPage(1);
  }

  const firstEntry = pagination.total ? (page - 1) * pagination.pageSize + 1 : 0;
  const lastEntry = Math.min(page * pagination.pageSize, pagination.total);

  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Workspace records</p>
          <h1>Change history</h1>
          <p>See which account created, updated, or removed business records and when.</p>
        </div>
      </header>
      {error && <div className="notice-strip audit-error" role="alert">{error}</div>}
      <form className="panel audit-controls" onSubmit={applyFilters}>
        <label className="audit-filter">
          <span>Record type</span>
          <select value={draft.entityType} onChange={(event) => setDraft({ ...draft, entityType: event.target.value })}>
            <option value="">All changes</option>
            {categories.slice(1).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="audit-filter">
          <span>Account email</span>
          <input
            type="email"
            value={draft.actor}
            onChange={(event) => setDraft({ ...draft, actor: event.target.value })}
            placeholder="name@example.com"
          />
        </label>
        <label className="audit-filter">
          <span>From</span>
          <input type="date" value={draft.from} max={draft.to || undefined} onChange={(event) => setDraft({ ...draft, from: event.target.value })} />
        </label>
        <label className="audit-filter">
          <span>Through</span>
          <input type="date" value={draft.to} min={draft.from || undefined} onChange={(event) => setDraft({ ...draft, to: event.target.value })} />
        </label>
        <div className="audit-filter-actions">
          <button className="button button-primary button-small" disabled={loading}>Apply filters</button>
          <button className="button button-secondary button-small" type="button" onClick={clearFilters} disabled={loading}>Clear</button>
        </div>
      </form>
      <section className="panel data-table-wrap">
        <div className="pagination">
          <span>{pagination.total ? `Showing ${firstEntry}–${lastEntry} of ${pagination.total} changes` : "No changes match these filters."}</span>
          <div className="pagination-actions">
            <button
              className="button button-secondary button-small"
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >Previous</button>
            <span>Page {page} of {pagination.totalPages}</span>
            <button
              className="button button-secondary button-small"
              type="button"
              disabled={page >= pagination.totalPages || loading}
              onClick={() => setPage((value) => value + 1)}
            >Next</button>
          </div>
        </div>
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
              {!entries.length && <tr><td colSpan={5}>No changes found for the selected filters.</td></tr>}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
