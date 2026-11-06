import { useEffect, useState, type FormEvent } from "react";

type ProductMetric = {
  productId: number; name: string; sku: string; unit: string; unitsSold: number;
  salesZmw: string | null; recordedGrossProfitZmw: string | null;
};
type AnalyticsReport = {
  totals: { salesZmw: string; recordedGrossProfitZmw: string | null };
  products: ProductMetric[];
  salesByMonth: { month: string; salesZmw: string }[];
  customerSummary: { customersWithSales: number; repeatCustomers: number; fulfilledOrders: number; unitsDelivered: number };
  topCustomers: { customerId: number; name: string; salesZmw: string; orders: number }[];
};
type DashboardData = {
  metrics: { inventoryValueZmw: string; inStockProducts: number; activeProducts: number; openOrders: number };
  replenishment: { id: number; name: string; sku: string; available: number; incoming: number; suggestedQuantity: number }[];
  cashForecast: { estimatedClosingZmw: string; assumption: string };
};
const money = (value: string | null | undefined) => value == null ? "—" : `ZMW ${Number(value).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateRange = () => {
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth() - 11, 1);
  return {
    from: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-01`,
    to: end.toISOString().slice(0, 10),
  };
};
async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not load analytics.");
  return body;
}

export default function BusinessAnalyticsWorkspace() {
  const initial = dateRange();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function run(event?: FormEvent) {
    event?.preventDefault();
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ from, to });
      const [sales, overview] = await Promise.all([
        getJson<AnalyticsReport>(`/api/profitability?${query.toString()}`),
        getJson<DashboardData>("/api/business-dashboard"),
      ]);
      setReport(sales); setDashboard(overview);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load analytics.");
    } finally { setLoading(false); }
  }
  useEffect(() => { void run(); }, []);

  const products = (report?.products ?? []).filter((item) => item.unitsSold > 0)
    .sort((a, b) => Number(b.salesZmw ?? 0) - Number(a.salesZmw ?? 0)).slice(0, 10);
  const productMax = Math.max(1, ...products.map((item) => Number(item.salesZmw ?? 0)));
  const customerMax = Math.max(1, ...(report?.topCustomers ?? []).map((item) => Number(item.salesZmw)));
  const monthMax = Math.max(1, ...(report?.salesByMonth ?? []).map((item) => Number(item.salesZmw)));
  const cards = report && dashboard ? [
    ["Sales in period", money(report.totals.salesZmw)],
    ["Recorded gross profit", money(report.totals.recordedGrossProfitZmw)],
    ["Delivered orders", String(report.customerSummary.fulfilledOrders)],
    ["Buying customers", String(report.customerSummary.customersWithSales)],
    ["Repeat customers", String(report.customerSummary.repeatCustomers)],
    ["Units delivered", report.customerSummary.unitsDelivered.toLocaleString()],
    ["Inventory value", money(dashboard.metrics.inventoryValueZmw)],
    ["Estimated cash in 30 days", money(dashboard.cashForecast.estimatedClosingZmw)],
  ] : [];

  return <>
    <section className="page-heading"><div><p className="eyebrow">Business overview · ZMW</p><h1>Analytics</h1><p>Track sales, customer activity, product performance, stock and cash in one place.</p></div></section>
    <form className="panel profitability-controls analytics-date-controls" onSubmit={run}>
      <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required /></label>
      <label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} required /></label>
      <button className="button button-primary button-small" disabled={loading}>{loading ? "Loading…" : "Update analytics"}</button>
    </form>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {loading && !report ? <div className="panel panel-body">Loading business analytics…</div> : report && dashboard && <>
      <div className="metric-grid analytics-metrics">
        {cards.map(([label, value]) => <article className="metric-card" key={label}><div className="metric-top"><span>{label}</span></div><strong className="metric-value">{value}</strong></article>)}
      </div>
      <section className="panel analytics-panel">
        <div className="panel-heading"><div><h2>Monthly sales</h2><span>Sales counted when goods are delivered</span></div></div>
        {report.salesByMonth.length ? <div className="analytics-month-chart" role="img" aria-label="Monthly delivered sales for the selected period">
          {report.salesByMonth.map((month) => {
            const value = Number(month.salesZmw);
            const height = Math.max(3, value / monthMax * 100);
            return <div className="analytics-month" key={month.month} title={`${month.month}: ${money(month.salesZmw)}`}>
              <span className="analytics-month-value">{money(month.salesZmw)}</span>
              <div className="analytics-month-track"><div className="analytics-month-bar" style={{ height: `${height}%` }} /></div>
              <span className="analytics-month-label">{new Date(`${month.month}-01T00:00:00Z`).toLocaleDateString("en", { month: "short", year: "2-digit", timeZone: "UTC" })}</span>
            </div>;
          })}
        </div> : <p className="panel-body">No delivered sales in this period.</p>}
      </section>
      <div className="analytics-grid">
        <section className="panel analytics-panel">
          <div className="panel-heading"><div><h2>Top products</h2><span>Ranked by delivered sales value</span></div></div>
          <div className="analytics-ranking">{products.map((item, index) => <div className="analytics-rank-row" key={item.productId}>
            <div className="analytics-rank-title"><strong>{index + 1}. {item.name}</strong><span>{item.sku} · {item.unitsSold} {item.unit} sold</span></div>
            <div className="analytics-rank-track"><div style={{ width: `${Number(item.salesZmw ?? 0) / productMax * 100}%` }} /></div>
            <div className="analytics-rank-values"><strong>{money(item.salesZmw)}</strong><span>Gross profit {money(item.recordedGrossProfitZmw)}</span></div>
          </div>)}{!products.length && <p className="panel-body">No delivered product sales in this period.</p>}</div>
        </section>
        <section className="panel analytics-panel">
          <div className="panel-heading"><div><h2>Top customers</h2><span>Buying customers in the selected period</span></div></div>
          <div className="analytics-ranking">{report.topCustomers.map((customer, index) => <div className="analytics-customer-row" key={customer.customerId}>
            <div className="analytics-rank-title"><strong>{index + 1}. {customer.name}</strong><span>{customer.orders} delivered {customer.orders === 1 ? "order" : "orders"}</span></div>
            <div className="analytics-rank-track"><div style={{ width: `${Number(customer.salesZmw) / customerMax * 100}%` }} /></div>
            <strong>{money(customer.salesZmw)}</strong>
          </div>)}{!report.topCustomers.length && <p className="panel-body">No customers purchased in this period.</p>}</div>
        </section>
      </div>
      <div className="analytics-grid analytics-support-grid">
        <section className="panel analytics-panel">
          <div className="panel-heading"><div><h2>Stock to watch</h2><span>Current stock position, not limited to the report period</span></div></div>
          <div className="panel-body analytics-stock-list">
            <div><strong>{dashboard.metrics.inStockProducts}</strong><span>products with available stock</span></div>
            <div><strong>{dashboard.replenishment.length}</strong><span>products with reorder suggestions</span></div>
            {dashboard.replenishment.slice(0, 5).map((item) => <p key={item.id}>{item.name} · {item.sku}: {item.available} available, {item.incoming} incoming; suggested order {item.suggestedQuantity}</p>)}
            {!dashboard.replenishment.length && <p>No current reorder suggestions.</p>}
          </div>
        </section>
        <section className="panel analytics-panel">
          <div className="panel-heading"><div><h2>Other business checks</h2><span>Open activity and connected reports</span></div></div>
          <div className="panel-body analytics-links">
            <p><strong>{dashboard.metrics.openOrders}</strong> open sales orders · <strong>{dashboard.metrics.activeProducts}</strong> active products</p>
            <p>{dashboard.cashForecast.assumption}</p>
            <a href="/profitability">Open detailed product profitability</a>
            <a href="/marketing">Review campaign and customer segments</a>
            <a href="/payments">Review recorded customer and supplier payments</a>
          </div>
        </section>
      </div>
      <p className="report-footnote">Sales reflect recorded deliveries. Gross profit can be incomplete when stock costs or opening stock values have not been recorded. Customer rankings cover this period; campaign analysis and lifetime customer groups are on Marketing.</p>
    </>}
  </>;
}
