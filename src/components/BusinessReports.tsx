import { useEffect, useState, type FormEvent } from "react";

type DashboardData = {
  metrics: { products: number; activeProducts: number; customers: number; openOrders: number; monthSalesZmw: string; inStockProducts: number; inventoryValueZmw: string };
  replenishment: { id: number; name: string; sku: string; supplierName: string | null; available: number; incoming: number; salesLast90Days: number; reorderLevel: number; suggestedQuantity: number }[];
  recentOrders: { id: number; orderNumber: string; customerName: string; status: string; orderDate: string }[];
  cashForecast: { recordedCashZmw: string; expectedReceiptsZmw: string; expectedPaymentsZmw: string; estimatedClosingZmw: string; assumption: string };
  monthStart: string;
};
type ProfitReport = {
  period: { from: string | null; to: string | null };
  totals: { salesZmw: string; recordedCostZmw: string; recordedGrossProfitZmw: string | null; recordedGrossMarginPercent: string | null; estimatedGrossProfitZmw: string | null; productsMissingRecordedCost: number; productsMissingEstimatedCost: number };
  products: { productId: number; name: string; sku: string; unit: string; unitsSold: number; salesZmw: string | null; recordedCostZmw: string | null; recordedGrossProfitZmw: string | null; recordedGrossMarginPercent: string | null; estimatedGrossProfitZmw: string | null; costStatus: string }[];
};
const money = (value: string | null) => value == null ? "—" : `ZMW ${Number(value).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateDefaults = () => {
  const today = new Date().toISOString().slice(0, 10);
  return { from: `${today.slice(0, 8)}01`, to: today };
};
async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not load this report.");
  return body;
}

export function BusinessDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { getJson<DashboardData>("/api/business-dashboard").then(setData).catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load business figures.")); }, []);
  if (error) return <div className="alert alert-error">{error}</div>;
  if (!data) return <div className="panel panel-body">Loading business figures…</div>;
  const cards = [
    ["Sales this month", money(data.metrics.monthSalesZmw)],
    ["Open orders", String(data.metrics.openOrders)],
    ["Products in stock", String(data.metrics.inStockProducts)],
    ["Inventory value", money(data.metrics.inventoryValueZmw)],
    ["Active products", String(data.metrics.activeProducts)],
    ["Customers", String(data.metrics.customers)],
  ];
  return <section className="business-dashboard-data">
    <div className="metric-grid">{cards.map(([label, value]) => <article className="metric-card" key={label}><div className="metric-top"><span>{label}</span></div><strong className="metric-value">{value}</strong></article>)}</div>
    <div className="dashboard-lower">
      <section className="panel"><div className="panel-heading"><div><h2>Replenishment suggestions</h2><span>Based on your reorder level and incoming stock</span></div></div>
        <div className="panel-body">{data.replenishment.length ? data.replenishment.map((item) => <div className="recent-row" key={item.id}><div><span className="recent-name">{item.name} · {item.sku}</span><span className="recent-meta">Available {item.available} · Incoming {item.incoming} · Sold {item.salesLast90Days} in 90 days · {item.supplierName || "Supplier not set"}</span></div><span className="recent-price">Suggest {item.suggestedQuantity}</span></div>) : <p>No products are below their reorder level.</p>}</div>
      </section>
      <section className="panel"><div className="panel-heading"><h2>Recent orders</h2></div>
        <div className="panel-body">{data.recentOrders.length ? data.recentOrders.map((order) => <div className="recent-row" key={order.id}><div><span className="recent-name">{order.orderNumber} · {order.customerName}</span><span className="recent-meta">{order.orderDate}</span></div><span className="recent-price">{order.status}</span></div>) : <p>No sales orders yet.</p>}</div>
      </section>
    </div>
    <section className="panel cash-forecast-panel"><div className="panel-heading"><div><h2>30-day cash forecast</h2><span>A simple estimate from balances already in the books</span></div></div>
      <div className="cash-forecast-grid">
        <div><span>Recorded cash</span><strong>{money(data.cashForecast.recordedCashZmw)}</strong></div>
        <div><span>Expected receipts</span><strong>{money(data.cashForecast.expectedReceiptsZmw)}</strong></div>
        <div><span>Expected payments</span><strong>{money(data.cashForecast.expectedPaymentsZmw)}</strong></div>
        <div><span>Estimated closing cash</span><strong>{money(data.cashForecast.estimatedClosingZmw)}</strong></div>
      </div>
      <p className="report-footnote">{data.cashForecast.assumption} Opening cash balances are not recorded yet, so this estimate may be incomplete.</p>
    </section>
    <p className="report-footnote">Sales are counted as each delivery is recorded. Inventory value uses recorded accounting entries; stock without an opening value may be missing.</p>
  </section>;
}

export default function ProfitabilityWorkspace() {
  const initial = dateDefaults();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [report, setReport] = useState<ProfitReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function run(event?: FormEvent) {
    event?.preventDefault();
    setError(""); setLoading(true);
    try {
      const query = new URLSearchParams({ from, to });
      setReport(await getJson<ProfitReport>(`/api/profitability?${query.toString()}`));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load profitability."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void run(); }, []);
  return <>
    <section className="page-heading"><div><p className="eyebrow">Business reports · ZMW</p><h1>Profitability</h1><p>Compare recorded sales costs with product cost estimates.</p></div></section>
    <form className="panel profitability-controls" onSubmit={run}>
      <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <button className="button button-primary button-small" disabled={loading}>{loading ? "Loading…" : "Run report"}</button>
    </form>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {report && <>
      <div className="metric-grid profitability-metrics">
        <article className="metric-card"><div className="metric-top"><span>Fulfilled sales</span></div><strong className="metric-value">{money(report.totals.salesZmw)}</strong></article>
        <article className="metric-card"><div className="metric-top"><span>Recorded product cost</span></div><strong className="metric-value">{money(report.totals.recordedCostZmw)}</strong></article>
        <article className="metric-card"><div className="metric-top"><span>Recorded gross profit</span></div><strong className="metric-value">{money(report.totals.recordedGrossProfitZmw)}</strong><span className="metric-detail">{report.totals.recordedGrossMarginPercent == null ? "Incomplete cost data" : `${report.totals.recordedGrossMarginPercent}% margin`}</span></article>
        <article className="metric-card"><div className="metric-top"><span>Estimated gross profit</span></div><strong className="metric-value">{money(report.totals.estimatedGrossProfitZmw)}</strong><span className="metric-detail">Uses current estimated product costs</span></article>
      </div>
      <div className="notice-strip report-footnote">Gross profit is before marketing, wages, rent, tax, and other costs. Recorded costs may be incomplete for stock without opening values. A dash means the report does not have enough cost data.</div>
      <section className="panel data-table-wrap"><table><thead><tr><th>Product</th><th>Units sold</th><th>Sales</th><th>Recorded stock cost</th><th>Recorded gross profit</th><th>Margin</th><th>Estimated gross profit</th></tr></thead><tbody>{report.products.filter((p) => p.unitsSold > 0).map((p) => <tr key={p.productId}><td>{p.name}<br /><small>{p.sku}</small></td><td>{p.unitsSold} {p.unit}</td><td>{money(p.salesZmw)}</td><td>{money(p.recordedCostZmw)}</td><td>{money(p.recordedGrossProfitZmw)}</td><td>{p.recordedGrossMarginPercent == null ? "—" : `${p.recordedGrossMarginPercent}%`}</td><td>{money(p.estimatedGrossProfitZmw)}</td></tr>)}{report.products.every((p) => p.unitsSold === 0) && <tr><td colSpan={7}>No fulfilled sales in this date range.</td></tr>}</tbody></table></section>
      <p className="report-footnote">Products missing recorded cost: {report.totals.productsMissingRecordedCost}. Products missing an estimated cost: {report.totals.productsMissingEstimatedCost}.</p>
    </>}
  </>;
}
