import { useEffect, useState, type FormEvent } from "react";
import { Pencil, Plus, RefreshCw, X } from "lucide-react";

type Campaign = { id: number; name: string; objective: string | null; channel: string | null; status: string; startsOn: string | null; endsOn: string | null; budgetZmw: string | null; notes: string | null };
type ContentItem = { id: number; campaignId: number | null; campaignName: string | null; title: string; platform: string; contentType: string; status: string; scheduledAt: string | null; caption: string | null; publishedUrl: string | null; notes: string | null };
type Expense = { id: number; campaignId: number | null; campaignName: string | null; category: string; description: string; amount: string; currency: string; exchangeRateToZmw: string; expenseDate: string; paid: boolean };
type MarketingReport = {
  period: { from: string | null; to: string | null };
  totals: { spendZmw: string; attributedRevenueZmw: string; attributedOrders: number; unattributedRevenueZmw: string; unattributedOrders: number; revenueToSpend: string | null };
  campaigns: { id: number; name: string; status: string; orderCount: number; attributedRevenueZmw: string; spendZmw: string; revenueToSpend: string | null }[];
  segments: { key: string; name: string; customerCount: number; fulfilledOrders: number; salesZmw: string; customers: { id: number; name: string; email: string | null; phone: string | null; fulfilledOrders: number; salesZmw: string }[] }[];
};
const campaignEmpty = { name: "", objective: "", channel: "", status: "draft", startsOn: "", endsOn: "", budgetZmw: "", notes: "" };
const contentEmpty = { campaignId: "", title: "", platform: "", contentType: "Post", status: "planned", scheduledAt: "", caption: "", publishedUrl: "", notes: "" };
const expenseEmpty = { campaignId: "", category: "Advertising", description: "", amount: "", currency: "ZMW", exchangeRateToZmw: "1", expenseDate: new Date().toISOString().slice(0, 10), paid: false, reference: "", notes: "" };

async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, {
    method, headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
function money(value: string, currency = "ZMW") {
  return `${currency} ${Number(value).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function convertedZmw(amount: string, rate: string) {
  const [whole, fraction = ""] = amount.split(".");
  const [rateWhole, rateFraction = ""] = rate.split(".");
  const amountCents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  const rateUnits = BigInt(rateWhole) * 100_000_000n + BigInt(rateFraction.padEnd(8, "0"));
  const cents = (amountCents * rateUnits + 50_000_000n) / 100_000_000n;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}
function campaignSpendZmw(campaignId: number, rows: Expense[]) {
  const cents = rows.filter((row) => row.campaignId === campaignId)
    .reduce((total, row) => {
      const value = convertedZmw(row.amount, row.exchangeRateToZmw).split(".");
      return total + BigInt(value[0]) * 100n + BigInt(value[1]);
    }, 0n);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}
function displayError(reason: unknown) {
  return reason instanceof Error ? reason.message : "The request could not be completed.";
}

export default function MarketingWorkspace() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [content, setContent] = useState<ContentItem[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [campaignForm, setCampaignForm] = useState(campaignEmpty);
  const [contentForm, setContentForm] = useState(contentEmpty);
  const [expenseForm, setExpenseForm] = useState(expenseEmpty);
  const [editingCampaign, setEditingCampaign] = useState<number | null>(null);
  const [editingContent, setEditingContent] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<MarketingReport | null>(null);
  const [reportFrom, setReportFrom] = useState(() => `${new Date().toISOString().slice(0, 8)}01`);
  const [reportTo, setReportTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [reportLoading, setReportLoading] = useState(false);
  const [selectedSegment, setSelectedSegment] = useState("repeat");

  async function load() {
    setLoading(true);
    try {
      const [c, p, e] = await Promise.all([
        request("/api/marketing/campaigns"), request("/api/marketing/content"), request("/api/marketing/expenses"),
      ]);
      setCampaigns(c.campaigns); setContent(p.content); setExpenses(e.expenses); setError("");
    } catch (reason) { setError(displayError(reason)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function runReport() {
    setError(""); setReportLoading(true);
    try {
      const query = new URLSearchParams({ from: reportFrom, to: reportTo });
      setReport(await request(`/api/marketing/reports?${query.toString()}`));
    } catch (reason) { setError(displayError(reason)); }
    finally { setReportLoading(false); }
  }

  async function submitCampaign(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      await request(editingCampaign ? `/api/marketing/campaigns/${editingCampaign}` : "/api/marketing/campaigns",
        editingCampaign ? "PATCH" : "POST", { ...campaignForm, startsOn: campaignForm.startsOn || null, endsOn: campaignForm.endsOn || null, budgetZmw: campaignForm.budgetZmw || null });
      setCampaignForm(campaignEmpty); setEditingCampaign(null); setMessage("Campaign saved."); await load();
    } catch (reason) { setError(displayError(reason)); }
  }
  async function submitContent(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      await request(editingContent ? `/api/marketing/content/${editingContent}` : "/api/marketing/content",
        editingContent ? "PATCH" : "POST", { ...contentForm, campaignId: contentForm.campaignId ? Number(contentForm.campaignId) : null,
          scheduledAt: contentForm.scheduledAt ? new Date(contentForm.scheduledAt).toISOString() : null,
          publishedUrl: contentForm.publishedUrl || null });
      setContentForm(contentEmpty); setEditingContent(null); setMessage("Content plan saved."); await load();
    } catch (reason) { setError(displayError(reason)); }
  }
  async function submitExpense(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      const result = await request("/api/marketing/expenses", "POST", { ...expenseForm, campaignId: expenseForm.campaignId ? Number(expenseForm.campaignId) : null });
      setExpenseForm(expenseEmpty); setMessage(`Expense recorded. ${money(result.amountZmw)} posted to accounting.`); await load();
    } catch (reason) { setError(displayError(reason)); }
  }
  function editCampaign(item: Campaign) {
    setEditingCampaign(item.id);
    setCampaignForm({ name: item.name, objective: item.objective ?? "", channel: item.channel ?? "", status: item.status, startsOn: item.startsOn ?? "", endsOn: item.endsOn ?? "", budgetZmw: item.budgetZmw ?? "", notes: item.notes ?? "" });
  }
  function editItem(item: ContentItem) {
    setEditingContent(item.id);
    setContentForm({ campaignId: item.campaignId ? String(item.campaignId) : "", title: item.title, platform: item.platform, contentType: item.contentType, status: item.status, scheduledAt: item.scheduledAt ? item.scheduledAt.slice(0, 16) : "", caption: item.caption ?? "", publishedUrl: item.publishedUrl ?? "", notes: item.notes ?? "" });
  }

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Marketing · campaigns + content</p><h1>Marketing workspace</h1><p>Plan activity, keep content moving, and record costs in ZMW.</p></div>
        <button className="button button-secondary button-small" onClick={() => void load()}><RefreshCw /> Refresh</button>
      </section>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {message && <div className="alert alert-success" role="status">{message}</div>}
      {loading ? <div className="panel panel-body">Loading marketing records…</div> : (
        <div className="marketing-layout">
          <section className="panel marketing-section">
            <div className="panel-heading"><div><h2>Campaigns</h2><span>Organise work by objective and channel</span></div></div>
            <form className="marketing-form" onSubmit={submitCampaign}>
              <label>Campaign name<input required maxLength={180} value={campaignForm.name} onChange={(e) => setCampaignForm({ ...campaignForm, name: e.target.value })} /></label>
              <div className="form-grid"><label>Channel<input placeholder="Social, retail, email…" value={campaignForm.channel} onChange={(e) => setCampaignForm({ ...campaignForm, channel: e.target.value })} /></label><label>Status<select value={campaignForm.status} onChange={(e) => setCampaignForm({ ...campaignForm, status: e.target.value })}>{["draft","active","paused","completed","cancelled"].map((x) => <option key={x}>{x}</option>)}</select></label></div>
              <label>Objective<textarea rows={2} value={campaignForm.objective} onChange={(e) => setCampaignForm({ ...campaignForm, objective: e.target.value })} /></label>
              <div className="form-grid"><label>Starts<input type="date" value={campaignForm.startsOn} onChange={(e) => setCampaignForm({ ...campaignForm, startsOn: e.target.value })} /></label><label>Ends<input type="date" value={campaignForm.endsOn} onChange={(e) => setCampaignForm({ ...campaignForm, endsOn: e.target.value })} /></label></div>
              <label>Budget (ZMW, optional)<input type="number" min="0" step="0.01" value={campaignForm.budgetZmw} onChange={(e) => setCampaignForm({ ...campaignForm, budgetZmw: e.target.value })} /></label>
              <button className="button button-primary button-small"><Plus /> {editingCampaign ? "Save campaign" : "Add campaign"}</button>
              {editingCampaign && <button type="button" className="button button-quiet button-small" onClick={() => { setEditingCampaign(null); setCampaignForm(campaignEmpty); }}><X /> Cancel edit</button>}
            </form>
            <div className="marketing-list">{campaigns.map((item) => <article className="marketing-row" key={item.id}><div><strong>{item.name}</strong><span>{item.channel || "No channel"} · {item.status}{item.budgetZmw ? ` · Budget ${money(item.budgetZmw)}` : ""} · Spent ${money(campaignSpendZmw(item.id, expenses))}</span></div><button className="icon-button" aria-label={`Edit ${item.name}`} onClick={() => editCampaign(item)}><Pencil /></button></article>)}{campaigns.length === 0 && <p className="muted-empty">No campaigns yet.</p>}</div>
          </section>

          <section className="panel marketing-section">
            <div className="panel-heading"><div><h2>Content plan</h2><span>Schedule drafts and track publishing</span></div></div>
            <form className="marketing-form" onSubmit={submitContent}>
              <label>Content title<input required value={contentForm.title} onChange={(e) => setContentForm({ ...contentForm, title: e.target.value })} /></label>
              <div className="form-grid"><label>Platform<input required placeholder="Instagram, Facebook…" value={contentForm.platform} onChange={(e) => setContentForm({ ...contentForm, platform: e.target.value })} /></label><label>Format<input required placeholder="Post, reel, story…" value={contentForm.contentType} onChange={(e) => setContentForm({ ...contentForm, contentType: e.target.value })} /></label></div>
              <div className="form-grid"><label>Campaign<select value={contentForm.campaignId} onChange={(e) => setContentForm({ ...contentForm, campaignId: e.target.value })}><option value="">No campaign</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Status<select value={contentForm.status} onChange={(e) => setContentForm({ ...contentForm, status: e.target.value })}>{["planned","in_progress","ready","published","cancelled"].map((x) => <option key={x}>{x.replace("_"," ")}</option>)}</select></label></div>
              <label>Scheduled date and time<input type="datetime-local" value={contentForm.scheduledAt} onChange={(e) => setContentForm({ ...contentForm, scheduledAt: e.target.value })} /></label>
              <label>Caption or brief<textarea rows={2} value={contentForm.caption} onChange={(e) => setContentForm({ ...contentForm, caption: e.target.value })} /></label>
              {contentForm.status === "published" && <label>Published URL<input type="url" value={contentForm.publishedUrl} onChange={(e) => setContentForm({ ...contentForm, publishedUrl: e.target.value })} /></label>}
              <button className="button button-primary button-small"><Plus /> {editingContent ? "Save content plan" : "Add content item"}</button>
              {editingContent && <button type="button" className="button button-quiet button-small" onClick={() => { setEditingContent(null); setContentForm(contentEmpty); }}><X /> Cancel edit</button>}
            </form>
            <div className="marketing-list">{content.map((item) => <article className="marketing-row" key={item.id}><div><strong>{item.title}</strong><span>{item.platform} · {item.contentType} · {item.status.replace("_"," ")}{item.scheduledAt ? ` · ${new Date(item.scheduledAt).toLocaleString()}` : ""}{item.campaignName ? ` · ${item.campaignName}` : ""}</span></div><button className="icon-button" aria-label={`Edit ${item.title}`} onClick={() => editItem(item)}><Pencil /></button></article>)}{content.length === 0 && <p className="muted-empty">No content planned yet.</p>}</div>
          </section>

          <section className="panel marketing-section marketing-expenses">
            <div className="panel-heading"><div><h2>Marketing expenses</h2><span>Recorded in source currency; posted to ZMW accounting</span></div></div>
            <form className="marketing-form marketing-expense-form" onSubmit={submitExpense}>
              <label>Description<input required value={expenseForm.description} onChange={(e) => setExpenseForm({ ...expenseForm, description: e.target.value })} /></label>
              <div className="form-grid"><label>Campaign<select value={expenseForm.campaignId} onChange={(e) => setExpenseForm({ ...expenseForm, campaignId: e.target.value })}><option value="">General marketing</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Category<input required value={expenseForm.category} onChange={(e) => setExpenseForm({ ...expenseForm, category: e.target.value })} /></label></div>
              <div className="form-grid"><label>Amount<input required type="number" min="0.01" step="0.01" value={expenseForm.amount} onChange={(e) => setExpenseForm({ ...expenseForm, amount: e.target.value })} /></label><label>Currency<input required maxLength={3} value={expenseForm.currency} onChange={(e) => setExpenseForm({ ...expenseForm, currency: e.target.value.toUpperCase() })} /></label></div>
              <div className="form-grid"><label>Rate to ZMW<input required type="number" min="0.00000001" step="0.00000001" value={expenseForm.exchangeRateToZmw} onChange={(e) => setExpenseForm({ ...expenseForm, exchangeRateToZmw: e.target.value })} /></label><label>Date<input required type="date" value={expenseForm.expenseDate} onChange={(e) => setExpenseForm({ ...expenseForm, expenseDate: e.target.value })} /></label></div>
              <label className="marketing-checkbox"><input type="checkbox" checked={expenseForm.paid} onChange={(e) => setExpenseForm({ ...expenseForm, paid: e.target.checked })} /> Paid at entry (credit cash and bank instead of accounts payable)</label>
              <label>Receipt/reference<input value={expenseForm.reference} onChange={(e) => setExpenseForm({ ...expenseForm, reference: e.target.value })} /></label>
              <button className="button button-primary button-small"><Plus /> Record expense</button>
            </form>
            <div className="table-wrap"><table><thead><tr><th>Date</th><th>Expense</th><th>Campaign</th><th>Amount</th><th>Rate</th><th>Posted ZMW</th><th>Status</th></tr></thead><tbody>{expenses.map((item) => <tr key={item.id}><td>{item.expenseDate}</td><td>{item.category} · {item.description}</td><td>{item.campaignName || "General"}</td><td>{money(item.amount,item.currency)}</td><td>{item.exchangeRateToZmw}</td><td>{money(convertedZmw(item.amount, item.exchangeRateToZmw))}</td><td>{item.paid ? "Paid" : "Unpaid"}</td></tr>)}{expenses.length === 0 && <tr><td colSpan={7}>No marketing expenses recorded.</td></tr>}</tbody></table></div>
          </section>
        </div>
      )}
      <section className="panel marketing-report">
        <div className="panel-heading"><div><h2>Marketing reports</h2><span>Campaign sales include fulfilled orders linked to a campaign. Customer groups use lifetime fulfilled orders.</span></div></div>
        <div className="marketing-report-controls">
          <label>From<input type="date" value={reportFrom} onChange={(e) => setReportFrom(e.target.value)} /></label>
          <label>To<input type="date" value={reportTo} onChange={(e) => setReportTo(e.target.value)} /></label>
          <button className="button button-primary button-small" disabled={reportLoading} onClick={() => void runReport()}>{reportLoading ? "Loading…" : "Run report"}</button>
        </div>
        {report && <>
          <div className="marketing-report-cards">
            <div><span>Marketing spend</span><strong>{money(report.totals.spendZmw)}</strong></div>
            <div><span>Attributed sales</span><strong>{money(report.totals.attributedRevenueZmw)}</strong></div>
            <div><span>Attributed orders</span><strong>{report.totals.attributedOrders}</strong></div>
            <div><span>Sales per ZMW spent</span><strong>{report.totals.revenueToSpend ?? "—"}</strong></div>
          </div>
          <div className="marketing-report-grid">
            <div className="table-wrap"><table><thead><tr><th>Campaign</th><th>Orders</th><th>Sales</th><th>Spend</th><th>Sales / spend</th></tr></thead><tbody>{report.campaigns.map((c) => <tr key={c.id}><td>{c.name} · {c.status}</td><td>{c.orderCount}</td><td>{money(c.attributedRevenueZmw)}</td><td>{money(c.spendZmw)}</td><td>{c.revenueToSpend ?? "—"}</td></tr>)}{report.campaigns.length === 0 && <tr><td colSpan={5}>No campaigns in the report yet.</td></tr>}</tbody></table></div>
            <div className="table-wrap"><table><thead><tr><th>Customer group</th><th>Customers</th><th>Orders</th><th>Lifetime sales</th></tr></thead><tbody>{report.segments.map((segment) => <tr key={segment.key}><td>{segment.name}</td><td>{segment.customerCount}</td><td>{segment.fulfilledOrders}</td><td>{money(segment.salesZmw)}</td></tr>)}</tbody></table></div>
          </div>
          <div className="marketing-segment-list">
            <label>Show customer group<select value={selectedSegment} onChange={(e) => setSelectedSegment(e.target.value)}>{report.segments.map((segment) => <option key={segment.key} value={segment.key}>{segment.name} ({segment.customerCount})</option>)}</select></label>
            <div className="table-wrap"><table><thead><tr><th>Customer</th><th>Contact</th><th>Fulfilled orders</th><th>Lifetime sales</th></tr></thead><tbody>{(report.segments.find((segment) => segment.key === selectedSegment)?.customers ?? []).map((customer) => <tr key={customer.id}><td>{customer.name}</td><td>{customer.email || customer.phone || "—"}</td><td>{customer.fulfilledOrders}</td><td>{money(customer.salesZmw)}</td></tr>)}</tbody></table></div>
          </div>
          <p className="marketing-report-note">Unattributed fulfilled sales: {money(report.totals.unattributedRevenueZmw)} across {report.totals.unattributedOrders} orders. Link orders to a campaign on the Sales orders page to include them in campaign results.</p>
        </>}
      </section>
    </>
  );
}
