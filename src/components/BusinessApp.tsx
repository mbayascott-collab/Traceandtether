import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowLeftRight,
  ArrowUpRight,
  BadgeDollarSign,
  BarChart3,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleOff,
  ClipboardList,
  Calculator,
  FolderOpen,
  FileText,
  History,
  Info,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Menu,
  Megaphone,
  Package,
  PackagePlus,
  Pencil,
  Plus,
  RefreshCw,
  Receipt,
  Bookmark,
  SlidersHorizontal,
  Search,
  ShieldCheck,
  Tags,
  Truck,
  Users,
  X,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import {
  ApiError,
  createCategory,
  createProduct,
  fetchCategories,
  fetchProducts,
  updateCategory,
  updateProduct,
  type Category,
  type CategoryStatus,
  type Product,
  type ProductInput,
  type ProductListResult,
  type ProductStatus,
} from "../lib/api";
import SupplierWorkspace from "./SupplierWorkspace";
import ProcurementWorkspace from "./ProcurementWorkspace";
import InventoryWorkspace from "./InventoryWorkspace";
import SalesWorkspace from "./SalesWorkspace";
import CustomerQuotesWorkspace from "./CustomerQuotesWorkspace";
import AccountingWorkspace from "./AccountingWorkspace";
import MarketingWorkspace from "./MarketingWorkspace";
import ProfitabilityWorkspace, { BusinessDashboard } from "./BusinessReports";
import PaymentsWorkspace from "./PaymentsWorkspace";
import UserAccessWorkspace from "./UserAccessWorkspace";
import BusinessAnalyticsWorkspace from "./BusinessAnalyticsWorkspace";
import AuditWorkspace from "./AuditWorkspace";

interface BusinessAppProps {
  userEmail: string;
  userRole: "owner" | "manager";
  onSignOut: () => void;
}

type ProductDraft = {
  sku: string;
  name: string;
  description: string;
  imageUrl: string;
  brand: string;
  categoryId: string;
  supplierName: string;
  supplierProductCode: string;
  purchaseCurrency: string;
  purchasePrice: string;
  estimatedLandedCostZmw: string;
  sellingPriceZmw: string;
  reorderThreshold: string;
  unit: string;
  status: ProductStatus;
};

type CategoryDraft = { name: string; description: string; status: CategoryStatus };
type Notice = { kind: "success" | "error" | "info"; message: string };

const PAGE_SIZE = 10;

function displayError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Check your connection and try again.";
}

function formatMoney(value: string | null | undefined, currency: string, locale: string): string {
  if (value == null || value.trim() === "") return "—";
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return `${currency.toUpperCase()} ${value}`;
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(BigInt(match[2]));
  const fraction = (match[3] ?? "").padEnd(2, "0");
  return `${currency.toUpperCase()} ${match[1]}${whole}.${fraction}`;
}

function formatZmw(value: string | null | undefined): string {
  return formatMoney(value, "ZMW", "en-ZM");
}

function formatPurchase(value: string | null, currency: string): string {
  return formatMoney(value, currency, "en");
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-ZM", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Lusaka",
  }).format(date);
}

function toInitials(email: string): string {
  const first = email.trim().split("@")[0] ?? "";
  const chunks = first.split(/[._-]+/).filter(Boolean);
  return (chunks.length > 1 ? `${chunks[0][0]}${chunks[1][0]}` : first.slice(0, 2)).toUpperCase() || "TD";
}

function emptyProductDraft(): ProductDraft {
  return {
    sku: "",
    name: "",
    description: "",
    imageUrl: "",
    brand: "",
    categoryId: "",
    supplierName: "",
    supplierProductCode: "",
    purchaseCurrency: "CNY",
    purchasePrice: "",
    estimatedLandedCostZmw: "",
    sellingPriceZmw: "",
    reorderThreshold: "0",
    unit: "unit",
    status: "draft",
  };
}

function productToDraft(product: Product): ProductDraft {
  return {
    sku: product.sku,
    name: product.name,
    description: product.description ?? "",
    imageUrl: product.imageUrl ?? "",
    brand: product.brand ?? "",
    categoryId: product.categoryId == null ? "" : String(product.categoryId),
    supplierName: product.supplierName ?? "",
    supplierProductCode: product.supplierProductCode ?? "",
    purchaseCurrency: product.purchaseCurrency,
    purchasePrice: product.purchasePrice ?? "",
    estimatedLandedCostZmw: product.estimatedLandedCostZmw ?? "",
    sellingPriceZmw: product.sellingPriceZmw ?? "",
    reorderThreshold: String(product.reorderThreshold),
    unit: product.unit,
    status: product.status,
  };
}

function toProductInput(draft: ProductDraft): ProductInput {
  return {
    sku: draft.sku.trim(),
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    imageUrl: draft.imageUrl.trim() || null,
    brand: draft.brand.trim() || null,
    categoryId: draft.categoryId ? Number(draft.categoryId) : null,
    supplierName: draft.supplierName.trim() || null,
    supplierProductCode: draft.supplierProductCode.trim() || null,
    purchaseCurrency: draft.purchaseCurrency.trim().toUpperCase(),
    purchasePrice: draft.purchasePrice.trim() || null,
    estimatedLandedCostZmw: draft.estimatedLandedCostZmw.trim() || null,
    sellingPriceZmw: draft.sellingPriceZmw.trim() || null,
    reorderThreshold: Number(draft.reorderThreshold),
    unit: draft.unit.trim(),
    status: draft.status,
  };
}

function productValidation(draft: ProductDraft): string {
  if (!draft.sku.trim()) return "Enter a SKU or internal product code.";
  if (!draft.name.trim()) return "Enter a product name.";
  if (!/^[A-Za-z]{3}$/.test(draft.purchaseCurrency.trim())) {
    return "Enter a valid purchase currency code, such as USD or CNY.";
  }
  if (!draft.unit.trim()) return "Enter the unit used to describe this product.";
  if (!/^\d+$/.test(draft.reorderThreshold) || Number(draft.reorderThreshold) < 0) {
    return "Reorder threshold must be a whole number of zero or more.";
  }
  const amounts: Array<[string, string]> = [
    ["Purchase price", draft.purchasePrice],
    ["Estimated landed cost", draft.estimatedLandedCostZmw],
    ["Selling price", draft.sellingPriceZmw],
  ];
  for (const [label, value] of amounts) {
    if (value.trim() && (!/^\d+(\.\d{1,2})?$/.test(value.trim()) || Number(value) < 0)) {
      return `${label} must be a non-negative amount with up to two decimal places.`;
    }
  }
  return "";
}

function productToInput(product: Product, status: ProductStatus): ProductInput {
  return toProductInput({ ...productToDraft(product), status });
}

function StatusBadge({ status }: { status: ProductStatus | CategoryStatus }) {
  return <span className={`status-badge status-${status}`}>{status}</span>;
}

function LoadingTable() {
  return (
    <div className="table-wrap" aria-label="Loading products" aria-busy="true">
      <div className="skeleton-row"><div className="skeleton" style={{ width: "38%", height: 10, marginTop: 19 }} /></div>
      <div className="skeleton-row"><div className="skeleton" style={{ width: "54%", height: 10, marginTop: 19 }} /></div>
      <div className="skeleton-row"><div className="skeleton" style={{ width: "43%", height: 10, marginTop: 19 }} /></div>
      <div className="skeleton-row"><div className="skeleton" style={{ width: "62%", height: 10, marginTop: 19 }} /></div>
      <div className="skeleton-row"><div className="skeleton" style={{ width: "35%", height: 10, marginTop: 19 }} /></div>
    </div>
  );
}

function AlertMessage({ notice }: { notice: Notice }) {
  const Icon = notice.kind === "error" ? AlertCircle : notice.kind === "success" ? CircleCheck : Info;
  return (
    <div className={`alert alert-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
      <Icon aria-hidden="true" />
      <span>{notice.message}</span>
    </div>
  );
}

export default function BusinessApp({ userEmail, userRole, onSignOut }: BusinessAppProps) {
  const [location, setLocation] = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [categoriesError, setCategoriesError] = useState("");
  const [categoryReload, setCategoryReload] = useState(0);
  const [productsResult, setProductsResult] = useState<ProductListResult | null>(null);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState("");
  const [productReload, setProductReload] = useState(0);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ProductStatus>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [productDialog, setProductDialog] = useState<Product | "new" | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<Category | "new" | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const productsRequest = useRef(0);
  const isDashboard = location === "/dashboard";
  const isAnalytics = location === "/analytics";
  const isProducts = location === "/products";
  const isCategories = location === "/categories";
  const isSuppliers = location === "/suppliers";
  const isQuotes = location === "/supplier-quotes";
  const isComparison = location === "/supplier-comparisons";
  const isPurchaseOrders = location === "/purchase-orders";
  const isShipments = location === "/shipments";
  const isImportExpenses = location === "/import-expenses";
  const isLandedCosts = location === "/landed-costs";
  const isInventory = location === "/inventory";
  const isStockReceipts = location === "/stock-receipts";
  const isReservations = location === "/reservations";
  const isStockAdjustments = location === "/stock-adjustments";
  const isCustomers = location === "/customers";
  const isCustomerQuotes = location === "/customer-quotes";
  const isSalesOrders = location === "/sales-orders";
  const isPayments = location === "/payments";
  const isAccounting = location === "/accounting";
  const isMarketing = location === "/marketing";
  const isProfitability = location === "/profitability";
  const isUserAccess = location === "/user-access";
  const isAuditHistory = location === "/audit-history";
  const currentSection = isAuditHistory ? "Change history" : isProducts ? "Products" : isCategories ? "Categories" : isSuppliers ? "Suppliers" : isQuotes ? "Quotations" : isComparison ? "Supplier comparison" : isPurchaseOrders ? "Purchase orders" : isShipments ? "Shipments" : isImportExpenses ? "Import expenses" : isLandedCosts ? "Landed costs" : isInventory ? "Inventory" : isStockReceipts ? "Stock receipts" : isReservations ? "Reservations" : isStockAdjustments ? "Stock adjustments" : isCustomers ? "Customers" : isCustomerQuotes ? "Customer quotes" : isSalesOrders ? "Sales orders" : isPayments ? "Payments" : isAccounting ? "Accounting" : isMarketing ? "Marketing" : isProfitability ? "Profitability" : isAnalytics ? "Analytics" : isUserAccess ? "User access" : "Dashboard";
  useEffect(() => {
    document.querySelector(".app-main")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
    setMobileNavOpen(false);
  }, [location]);

  useEffect(() => {
    if (!mobileNavOpen) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavOpen]);
  const allProducts = productsResult?.products ?? [];
  const pagination = productsResult?.pagination;

  useEffect(() => {
    let alive = true;
    setCategoriesLoading(true);
    setCategoriesError("");
    fetchCategories()
      .then((records) => {
        if (alive) setCategories(records);
      })
      .catch((error: unknown) => {
        if (alive) setCategoriesError(displayError(error));
      })
      .finally(() => {
        if (alive) setCategoriesLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [categoryReload]);

  useEffect(() => {
    const requestId = ++productsRequest.current;
    let alive = true;
    setProductsLoading(true);
    setProductsError("");
    const dashboard = location === "/dashboard";
    const params = dashboard
      ? { page: 1, pageSize: 6 }
      : {
          q: search.trim() || undefined,
          status: statusFilter,
          categoryId: categoryFilter === "all" ? undefined : Number(categoryFilter),
          page,
          pageSize: PAGE_SIZE,
        };
    fetchProducts(params)
      .then((result) => {
        if (alive && productsRequest.current === requestId) setProductsResult(result);
      })
      .catch((error: unknown) => {
        if (alive && productsRequest.current === requestId) setProductsError(displayError(error));
      })
      .finally(() => {
        if (alive && productsRequest.current === requestId) setProductsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [location, search, statusFilter, categoryFilter, page, productReload]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location]);

  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );
  const categoryActiveCount = categories.filter((category) => category.status === "active").length;
  const productCount = pagination?.total;
  const newestProducts = useMemo(
    () => [...allProducts].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [allProducts],
  );

  function refreshProducts() {
    setProductReload((value) => value + 1);
  }

  function announce(message: string) {
    setNotice({ kind: "success", message });
    window.setTimeout(() => setNotice((current) => (current?.message === message ? null : current)), 4200);
  }

  async function changeProductStatus(product: Product) {
    const nextStatus: ProductStatus = product.status === "active" ? "inactive" : "active";
    setBusyId(product.id);
    setNotice(null);
    try {
      await updateProduct(product.id, productToInput(product, nextStatus));
      announce(`${product.name} is now ${nextStatus}.`);
      refreshProducts();
    } catch (error) {
      setNotice({ kind: "error", message: displayError(error) });
    } finally {
      setBusyId(null);
    }
  }

  async function changeCategoryStatus(category: Category) {
    const nextStatus: CategoryStatus = category.status === "active" ? "inactive" : "active";
    setBusyId(category.id);
    setNotice(null);
    try {
      await updateCategory(category.id, {
        name: category.name,
        description: category.description,
        status: nextStatus,
      });
      announce(`${category.name} is now ${nextStatus}.`);
      setCategoryReload((value) => value + 1);
    } catch (error) {
      setNotice({ kind: "error", message: displayError(error) });
    } finally {
      setBusyId(null);
    }
  }

  function resetProductFilters() {
    setSearch("");
    setStatusFilter("all");
    setCategoryFilter("all");
    setPage(1);
  }

  return (
    <div className="trade-shell">
      <button
        className={`mobile-sidebar-scrim${mobileNavOpen ? " is-visible" : ""}`}
        aria-label="Close navigation"
        onClick={() => setMobileNavOpen(false)}
      />
      <aside className={`sidebar${mobileNavOpen ? " is-open" : ""}`} aria-label="Main navigation">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><Boxes /></div>
          <div>
            <div className="brand-name">TRACE&TETHER</div>
            <div className="brand-subtitle">Business workspace</div>
          </div>
        </div>
        <div className="nav-caption">Workspace</div>
        <nav className="side-nav" onClick={() => setMobileNavOpen(false)}>
          <Link href="/dashboard" aria-current={isDashboard ? "page" : undefined}>
            <LayoutDashboard aria-hidden="true" /><span>Dashboard</span>
          </Link>
          <Link href="/analytics" aria-current={isAnalytics ? "page" : undefined}>
            <BarChart3 aria-hidden="true" /><span>Analytics</span>
          </Link>
          <Link href="/products" aria-current={isProducts ? "page" : undefined}>
            <Package aria-hidden="true" /><span>Products</span>
          </Link>
          <Link href="/categories" aria-current={isCategories ? "page" : undefined}>
            <Tags aria-hidden="true" /><span>Categories</span>
          </Link>
          <Link href="/suppliers" aria-current={isSuppliers ? "page" : undefined}>
            <Users aria-hidden="true" /><span>Suppliers</span>
          </Link>
          <Link href="/supplier-quotes" aria-current={isQuotes ? "page" : undefined}>
            <FileText aria-hidden="true" /><span>Quotations</span>
          </Link>
          <Link href="/supplier-comparisons" aria-current={isComparison ? "page" : undefined}>
            <ArrowLeftRight aria-hidden="true" /><span>Compare offers</span>
          </Link>
          <Link href="/purchase-orders" aria-current={isPurchaseOrders ? "page" : undefined}>
            <ClipboardList aria-hidden="true" /><span>Purchase orders</span>
          </Link>
          <Link href="/shipments" aria-current={isShipments ? "page" : undefined}>
            <Truck aria-hidden="true" /><span>Shipments</span>
          </Link>
          <Link href="/import-expenses" aria-current={isImportExpenses ? "page" : undefined}>
            <Receipt aria-hidden="true" /><span>Import expenses</span>
          </Link>
          <Link href="/landed-costs" aria-current={isLandedCosts ? "page" : undefined}>
            <Calculator aria-hidden="true" /><span>Landed costs</span>
          </Link>
          <Link href="/inventory" aria-current={isInventory ? "page" : undefined}>
            <Boxes aria-hidden="true" /><span>Inventory</span>
          </Link>
          <Link href="/stock-receipts" aria-current={isStockReceipts ? "page" : undefined}>
            <ClipboardList aria-hidden="true" /><span>Stock receipts</span>
          </Link>
          <Link href="/reservations" aria-current={isReservations ? "page" : undefined}>
            <Bookmark aria-hidden="true" /><span>Reservations</span>
          </Link>
          <Link href="/stock-adjustments" aria-current={isStockAdjustments ? "page" : undefined}>
            <SlidersHorizontal aria-hidden="true" /><span>Adjustments</span>
          </Link>
          <Link href="/customers" aria-current={isCustomers ? "page" : undefined}>
            <Users aria-hidden="true" /><span>Customers</span>
          </Link>
          <Link href="/customer-quotes" aria-current={isCustomerQuotes ? "page" : undefined}>
            <FileText aria-hidden="true" /><span>Customer quotes</span>
          </Link>
          <Link href="/sales-orders" aria-current={isSalesOrders ? "page" : undefined}>
            <BadgeDollarSign aria-hidden="true" /><span>Sales orders</span>
          </Link>
          <Link href="/payments" aria-current={isPayments ? "page" : undefined}>
            <Receipt aria-hidden="true" /><span>Payments</span>
          </Link>
          <Link href="/accounting" aria-current={isAccounting ? "page" : undefined}>
            <Calculator aria-hidden="true" /><span>Accounting</span>
          </Link>
          <Link href="/marketing" aria-current={isMarketing ? "page" : undefined}>
            <Megaphone aria-hidden="true" /><span>Marketing</span>
          </Link>
          <Link href="/profitability" aria-current={isProfitability ? "page" : undefined}>
            <BadgeDollarSign aria-hidden="true" /><span>Profitability</span>
          </Link>
          <Link href="/user-access" aria-current={isUserAccess ? "page" : undefined}>
            <ShieldCheck aria-hidden="true" /><span>User access</span>
          </Link>
          <Link href="/audit-history" aria-current={isAuditHistory ? "page" : undefined}>
            <History aria-hidden="true" /><span>Change history</span>
          </Link>
        </nav>
        <div className="sidebar-spacer" />
        <div className="workspace-note">
          <span>Private by design</span>
          <p>Supplier details and cost estimates stay inside this owner-only workspace.</p>
        </div>
        <div className="account-block">
          <div className="account-avatar" aria-hidden="true">{toInitials(userEmail)}</div>
          <div className="account-copy">
            <span className="account-label">Owner</span>
            <div className="account-email" title={userEmail}>{userEmail}</div>
          </div>
          <button className="signout-button" aria-label="Sign out" title="Sign out" onClick={onSignOut}>
            <LogOut aria-hidden="true" />
          </button>
        </div>
      </aside>

      <main className="app-main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="mobile-menu-button"
              aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={mobileNavOpen}
              onClick={() => setMobileNavOpen((open) => !open)}
            >
              {mobileNavOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
            </button>
            <div className="breadcrumbs">
              <span>Trace&Tether</span><ChevronRight aria-hidden="true" /><strong>{currentSection}</strong>
            </div>
          </div>
          <span className="private-pill"><LockKeyhole aria-hidden="true" />Owner-only workspace</span>
        </header>

        <div className="page-content">
          {notice && <AlertMessage notice={notice} />}

          {isDashboard && (
            <>
              <section className="page-heading">
                <div>
                  <p className="eyebrow">Business overview · Zambia</p>
                  <h1>Business dashboard</h1>
                  <p>See sales, stock, orders, and product results in one place.</p>
                </div>
                <button className="button button-primary" onClick={() => setLocation("/products")}>
                  <PackagePlus aria-hidden="true" /> Manage products
                </button>
              </section>
              <section className="dashboard-intro" aria-label="Workspace introduction">
                <div>
                  <p className="eyebrow">Business overview</p>
                  <h2>Track what is selling and what needs attention.</h2>
                  <p>Figures come from saved orders, stock movements, and accounting entries.</p>
                </div>
                <div className="intro-stamp" aria-hidden="true"><span>Source<br />to shelf</span></div>
              </section>
              <BusinessDashboard />
              <div className="section-caption">
                <h2>Catalogue snapshot</h2>
                <span>Product records and category details.</span>
              </div>
              <section className="metric-grid" aria-label="Workspace totals">
                <article className="metric-card">
                  <div className="metric-top"><span>Product records</span><span className="metric-icon"><Package aria-hidden="true" /></span></div>
                  <strong className="metric-value">{productsLoading || productsError ? "—" : productCount ?? "—"}</strong>
                  <span className="metric-detail">{productsError ? "Unavailable until the catalogue loads" : "Total products in the catalogue"}</span>
                </article>
                <article className="metric-card">
                  <div className="metric-top"><span>Active categories</span><span className="metric-icon copper"><Tags aria-hidden="true" /></span></div>
                  <strong className="metric-value">{categoriesLoading ? "—" : categoriesError ? "—" : categoryActiveCount}</strong>
                  <span className="metric-detail">{categoriesError ? "Unavailable until categories load" : `of ${categories.length} categories`}</span>
                </article>
                <article className="metric-card">
                  <div className="metric-top"><span>Newest in returned records</span><span className="metric-icon"><RefreshCw aria-hidden="true" /></span></div>
                  <strong className="metric-value" style={{ fontSize: 19 }}>
                    {productsLoading || productsError ? "—" : newestProducts[0] ? formatDate(newestProducts[0].updatedAt) : "—"}
                  </strong>
                  <span className="metric-detail">{productsError ? "Unavailable until the catalogue loads" : newestProducts[0]?.name ?? "No product record yet"}</span>
                </article>
              </section>
              <div className="dashboard-lower">
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Product records</h2>
                    <Link href="/products" className="button button-quiet button-small">Open catalogue <ArrowUpRight aria-hidden="true" /></Link>
                  </div>
                  <div className="panel-body">
                    {productsError ? (
                      <div className="alert alert-error" role="alert"><AlertCircle aria-hidden="true" /><span>{productsError}</span></div>
                    ) : productsLoading ? (
                      <div aria-label="Loading product records" aria-busy="true">
                        <div className="skeleton-row"><div className="skeleton" style={{ width: "65%", height: 10, marginTop: 19 }} /></div>
                        <div className="skeleton-row"><div className="skeleton" style={{ width: "48%", height: 10, marginTop: 19 }} /></div>
                        <div className="skeleton-row"><div className="skeleton" style={{ width: "57%", height: 10, marginTop: 19 }} /></div>
                      </div>
                    ) : newestProducts.length ? (
                      <div className="recent-list">
                        {newestProducts.slice(0, 5).map((product) => (
                          <div className="recent-row" key={product.id}>
                            <div>
                              <span className="recent-name">{product.name}</span>
                              <span className="recent-meta">{product.sku} · {product.status}</span>
                            </div>
                            <span className="recent-price">{formatZmw(product.sellingPriceZmw)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-state" style={{ padding: "22px 10px" }}>
                        <div className="empty-mark"><Package aria-hidden="true" /></div>
                        <h3>Your catalogue starts here</h3>
                        <p>Add your first product to connect its supplier details with your ZMW pricing.</p>
                        <button className="button button-primary" onClick={() => setLocation("/products")}>
                          <Plus aria-hidden="true" /> Add a product
                        </button>
                      </div>
                    )}
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-heading"><h2>Workspace shortcuts</h2></div>
                  <div className="panel-body">
                    <Link className="quick-link" href="/products">
                      <span className="quick-link-icon"><PackagePlus aria-hidden="true" /></span>
                      <span><strong>Review products</strong><small>Search, price and update status</small></span>
                    </Link>
                    <Link className="quick-link" href="/categories">
                      <span className="quick-link-icon"><FolderOpen aria-hidden="true" /></span>
                      <span><strong>Organise categories</strong><small>Keep the catalogue easy to scan</small></span>
                    </Link>
                    <Link className="quick-link" href="/profitability">
                      <span className="quick-link-icon"><BadgeDollarSign aria-hidden="true" /></span>
                      <span><strong>Review profitability</strong><small>Compare recorded and estimated results</small></span>
                    </Link>
                    <div className="notice-strip">
                      <ShieldCheck aria-hidden="true" />
                      <span>Product estimates differ from recorded sales costs. Open the profitability report to compare them.</span>
                    </div>
                  </div>
                </section>
              </div>
            </>
          )}
          {isAnalytics && <BusinessAnalyticsWorkspace />}

          {isProducts && (
            <>
              <section className="page-heading">
                <div>
                  <p className="eyebrow">Catalogue · sourcing + pricing</p>
                  <h1>Products</h1>
                  <p>Keep supplier references and estimated ZMW costs alongside each product.</p>
                </div>
                <button className="button button-primary" onClick={() => setProductDialog("new")}>
                  <Plus aria-hidden="true" /> Add product
                </button>
              </section>
              {productsError && (
                <div className="alert alert-error" role="alert">
                  <AlertCircle aria-hidden="true" /><span>{productsError}</span>
                  <button className="button button-secondary button-small" onClick={refreshProducts}><RefreshCw aria-hidden="true" /> Retry</button>
                </div>
              )}
              {categoriesError && (
                <div className="alert alert-error" role="alert">
                  <AlertCircle aria-hidden="true" /><span>Categories could not be loaded: {categoriesError}</span>
                  <button className="button button-secondary button-small" onClick={() => setCategoryReload((value) => value + 1)}>Retry</button>
                </div>
              )}
              <div className="toolbar" role="search" aria-label="Filter products">
                <label className="search-field">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => { setSearch(event.target.value); setPage(1); }}
                    placeholder="Search name, SKU, brand or supplier"
                    aria-label="Search products"
                  />
                </label>
                <select className="filter-select" value={statusFilter} aria-label="Filter by product status" onChange={(event) => { setStatusFilter(event.target.value as "all" | ProductStatus); setPage(1); }}>
                  <option value="all">All statuses</option>
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
                <select className="filter-select" value={categoryFilter} aria-label="Filter by category" onChange={(event) => { setCategoryFilter(event.target.value); setPage(1); }}>
                  <option value="all">All categories</option>
                  {categories.map((category) => <option key={category.id} value={category.id}>{category.name}{category.status === "inactive" ? " · inactive" : ""}</option>)}
                </select>
                {(search || statusFilter !== "all" || categoryFilter !== "all") && (
                  <button className="button button-secondary button-small" onClick={resetProductFilters}>Clear filters</button>
                )}
              </div>
              {productsLoading ? <LoadingTable /> : productsResult && productsResult.products.length > 0 ? (
                <>
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th scope="col">Product</th>
                          <th scope="col">Category</th>
                          <th scope="col">Supplier</th>
                          <th scope="col">Purchase price</th>
                          <th scope="col">Est. landed</th>
                          <th scope="col">Selling price</th>
                          <th scope="col">Est. gross / margin</th>
                          <th scope="col">Status</th>
                          <th scope="col"><span className="sr-only">Actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {productsResult.products.map((product) => (
                          <tr key={product.id}>
                            <td>
                              {product.imageUrl && <img className="product-image-thumb" src={product.imageUrl} alt="" loading="lazy" />}
                              <span className="product-primary" title={product.name}>{product.name}</span>
                              <span className="product-secondary">{product.sku}{product.brand ? ` · ${product.brand}` : ""}</span>
                            </td>
                            <td>{product.categoryId == null ? "—" : categoryById.get(product.categoryId) ?? "Unlisted"}</td>
                            <td>
                              <span className="product-primary">{product.supplierName || "—"}</span>
                              {product.supplierProductCode && <span className="product-secondary">{product.supplierProductCode}</span>}
                            </td>
                            <td className="money-cell">{formatPurchase(product.purchasePrice, product.purchaseCurrency)}</td>
                            <td className="money-cell">{formatZmw(product.estimatedLandedCostZmw)}</td>
                            <td className="money-cell">{formatZmw(product.sellingPriceZmw)}</td>
                            <td className="money-cell">
                              <span>{formatZmw(product.estimatedGrossProfitZmw)}</span>
                              <span className="product-secondary">
                                {product.estimatedGrossMarginPercent == null || product.estimatedGrossMarginPercent === ""
                                  ? "Estimate unavailable"
                                  : `Est. ${product.estimatedGrossMarginPercent}%`}
                              </span>
                            </td>
                            <td><StatusBadge status={product.status} /></td>
                            <td>
                              <div className="table-actions">
                                <button className="icon-button" aria-label={`Edit ${product.name}`} title="Edit product" onClick={() => setProductDialog(product)}>
                                  <Pencil aria-hidden="true" />
                                </button>
                                <button
                                  className="icon-button"
                                  aria-label={`${product.status === "active" ? "Deactivate" : "Activate"} ${product.name}`}
                                  title={product.status === "active" ? "Deactivate product" : "Activate product"}
                                  disabled={busyId === product.id}
                                  onClick={() => changeProductStatus(product)}
                                >
                                  {product.status === "active" ? <CircleOff aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="pagination">
                    <span>
                      {pagination?.total ? `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, pagination.total)} of ${pagination.total}` : "No product records"}
                      {pagination?.total ? " products" : ""}
                    </span>
                    <div className="pagination-actions">
                      <button className="button button-secondary button-small" disabled={page <= 1 || productsLoading} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                        <ChevronLeft aria-hidden="true" /> Previous
                      </button>
                      <button className="button button-secondary button-small" disabled={!pagination || page >= pagination.totalPages || productsLoading} onClick={() => setPage((value) => value + 1)}>
                        Next <ChevronRight aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="panel">
                  <div className="empty-state">
                    <div className="empty-mark">{search || statusFilter !== "all" || categoryFilter !== "all" ? <Search aria-hidden="true" /> : <Package aria-hidden="true" />}</div>
                    <h3>{search || statusFilter !== "all" || categoryFilter !== "all" ? "No products match those filters" : "No products in the catalogue yet"}</h3>
                    <p>{search || statusFilter !== "all" || categoryFilter !== "all" ? "Try a different search or clear the current filters." : "Add a product to record its source currency, supplier details and ZMW pricing together."}</p>
                    {search || statusFilter !== "all" || categoryFilter !== "all" ? (
                      <button className="button button-secondary" onClick={resetProductFilters}>Clear filters</button>
                    ) : (
                      <button className="button button-primary" onClick={() => setProductDialog("new")}><Plus aria-hidden="true" /> Add first product</button>
                    )}
                  </div>
                </div>
              )}
              <div className="notice-strip">
                <BadgeDollarSign aria-hidden="true" />
                <span>Purchase price uses its stated source currency. Landed cost and selling price are shown in ZMW. Profitability figures, when available, are estimates—not actual profit.</span>
              </div>
            </>
          )}

          {isCategories && (
            <>
              <section className="page-heading">
                <div>
                  <p className="eyebrow">Catalogue structure</p>
                  <h1>Categories</h1>
                  <p>Group products in a way that reflects how you source and resell.</p>
                </div>
                <button className="button button-primary" onClick={() => setCategoryDialog("new")}>
                  <Plus aria-hidden="true" /> Add category
                </button>
              </section>
              {categoriesError && (
                <div className="alert alert-error" role="alert">
                  <AlertCircle aria-hidden="true" /><span>{categoriesError}</span>
                  <button className="button button-secondary button-small" onClick={() => setCategoryReload((value) => value + 1)}><RefreshCw aria-hidden="true" /> Retry</button>
                </div>
              )}
              {categoriesLoading ? (
                <div className="category-grid" aria-label="Loading categories" aria-busy="true">
                  {[1, 2, 3, 4].map((item) => <div className="category-card" key={item}><div className="skeleton" style={{ width: "48%", height: 16 }} /><div className="skeleton" style={{ width: "78%", height: 10, marginTop: 16 }} /><div className="skeleton" style={{ width: "100%", height: 1, marginTop: 25 }} /></div>)}
                </div>
              ) : categories.length ? (
                <div className="category-grid">
                  {categories.map((category) => (
                    <article className="category-card" key={category.id}>
                      <div className="category-card-top">
                        <h3>{category.name}</h3>
                        <StatusBadge status={category.status} />
                      </div>
                      <p className="category-description">{category.description || "No description added."}</p>
                      <div className="category-card-foot">
                        <span>Updated {formatDate(category.updatedAt)}</span>
                        <div className="category-actions">
                          <button className="icon-button" aria-label={`Edit ${category.name}`} title="Edit category" onClick={() => setCategoryDialog(category)}>
                            <Pencil aria-hidden="true" />
                          </button>
                          <button
                            className="icon-button"
                            aria-label={`${category.status === "active" ? "Deactivate" : "Activate"} ${category.name}`}
                            title={category.status === "active" ? "Deactivate category" : "Activate category"}
                            disabled={busyId === category.id}
                            onClick={() => changeCategoryStatus(category)}
                          >
                            {category.status === "active" ? <CircleOff aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="panel">
                  <div className="empty-state">
                    <div className="empty-mark"><Tags aria-hidden="true" /></div>
                    <h3>Give your catalogue some structure</h3>
                    <p>Create categories that fit the way you source, group and price products.</p>
                    <button className="button button-primary" onClick={() => setCategoryDialog("new")}><Plus aria-hidden="true" /> Add first category</button>
                  </div>
                </div>
              )}
              <div className="notice-strip">
                <Info aria-hidden="true" /><span>Deactivating a category keeps existing product records intact. It will remain available to edit but is no longer active.</span>
              </div>
            </>
          )}
          {isSuppliers && <SupplierWorkspace mode="suppliers" />}
          {isQuotes && <SupplierWorkspace mode="quotes" />}
          {isComparison && <SupplierWorkspace mode="comparison" />}
          {isPurchaseOrders && <ProcurementWorkspace mode="orders" />}
          {isShipments && <ProcurementWorkspace mode="shipments" />}
          {isImportExpenses && <ProcurementWorkspace mode="expenses" />}
          {isLandedCosts && <ProcurementWorkspace mode="landed" />}
          {isInventory && <InventoryWorkspace mode="overview" />}
          {isStockReceipts && <InventoryWorkspace mode="receipts" />}
          {isReservations && <InventoryWorkspace mode="reservations" />}
          {isStockAdjustments && <InventoryWorkspace mode="adjustments" />}
          {isCustomers && <SalesWorkspace mode="customers" canEditCampaignAttribution={userRole === "owner"} />}
          {isCustomerQuotes && <CustomerQuotesWorkspace />}
          {isSalesOrders && <SalesWorkspace mode="orders" canEditCampaignAttribution={userRole === "owner"} />}
          {isPayments && <PaymentsWorkspace />}
          {isAccounting && <AccountingWorkspace />}
          {isMarketing && <MarketingWorkspace />}
          {isProfitability && <ProfitabilityWorkspace />}
          {isUserAccess && <UserAccessWorkspace />}
          {isAuditHistory && <AuditWorkspace />}
        </div>
      </main>

      {productDialog !== null && (
        <ProductModal
          product={productDialog === "new" ? null : productDialog}
          categories={categories}
          onClose={() => setProductDialog(null)}
          onSaved={(message) => {
            setProductDialog(null);
            announce(message);
            refreshProducts();
          }}
        />
      )}
      {categoryDialog !== null && (
        <CategoryModal
          category={categoryDialog === "new" ? null : categoryDialog}
          onClose={() => setCategoryDialog(null)}
          onSaved={(message) => {
            setCategoryDialog(null);
            announce(message);
            setCategoryReload((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}

function ProductModal({
  product,
  categories,
  onClose,
  onSaved,
}: {
  product: Product | null;
  categories: Category[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [draft, setDraft] = useState<ProductDraft>(() => product ? productToDraft(product) : emptyProductDraft());
  const [error, setError] = useState("");
  const [validation, setValidation] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const issue = productValidation(draft);
    setValidation(issue);
    setError("");
    if (issue) return;
    setSaving(true);
    try {
      const input = toProductInput(draft);
      if (product) {
        await updateProduct(product.id, input);
        onSaved(`${product.name} updated.`);
      } else {
        await createProduct(input);
        onSaved(`${draft.name.trim()} added to the catalogue.`);
      }
    } catch (caught) {
      setError(displayError(caught));
    } finally {
      setSaving(false);
    }
  }

  function update<K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    if (validation) setValidation("");
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="product-modal-title">
        <div className="modal-header">
          <div>
            <p className="eyebrow">{product ? "Catalogue record" : "New catalogue record"}</p>
            <h2 id="product-modal-title">{product ? "Edit product" : "Add product"}</h2>
            <p>Source details and ZMW price estimates, kept together.</p>
          </div>
          <button className="icon-button" aria-label="Close product form" disabled={saving} onClick={onClose}><X aria-hidden="true" /></button>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="modal-body">
            {error && <AlertMessage notice={{ kind: "error", message: error }} />}
            {validation && <AlertMessage notice={{ kind: "error", message: validation }} />}
            <div className="form-grid">
              <div className="form-section-label field-full"><Package aria-hidden="true" /> Product identity</div>
              <div className="field">
                <label htmlFor="product-sku">SKU / internal code <em>Required</em></label>
                <input id="product-sku" value={draft.sku} onChange={(event) => update("sku", event.target.value)} maxLength={80} required />
              </div>
              <div className="field">
                <label htmlFor="product-name">Product name <em>Required</em></label>
                <input id="product-name" value={draft.name} onChange={(event) => update("name", event.target.value)} maxLength={160} required />
              </div>
              <div className="field">
                <label htmlFor="product-brand">Brand</label>
                <input id="product-brand" value={draft.brand} onChange={(event) => update("brand", event.target.value)} maxLength={120} placeholder="Optional" />
              </div>
              <div className="field">
                <label htmlFor="product-category">Category</label>
                <select id="product-category" value={draft.categoryId} onChange={(event) => update("categoryId", event.target.value)}>
                  <option value="">No category</option>
                  {categories.map((category) => <option key={category.id} value={category.id}>{category.name}{category.status === "inactive" ? " · inactive" : ""}</option>)}
                </select>
              </div>
              <div className="field field-full">
                <label htmlFor="product-description">Description</label>
                <textarea id="product-description" value={draft.description} onChange={(event) => update("description", event.target.value)} maxLength={2000} placeholder="A short description for your own reference" />
              </div>
              <div className="field field-full">
                <label htmlFor="product-image-url">Product picture link</label>
                <input id="product-image-url" type="url" value={draft.imageUrl} onChange={(event) => update("imageUrl", event.target.value)} maxLength={1000} placeholder="https://…" />
                <small>Optional. You can add a picture link now, or leave this blank until you have one.</small>
                {draft.imageUrl && /^https?:\/\//i.test(draft.imageUrl) && <img className="product-image-preview" src={draft.imageUrl} alt={`Preview of ${draft.name || "product"}`} />}
              </div>

              <div className="form-section-label field-full"><Truck aria-hidden="true" /> Supplier & sourcing</div>
              <div className="field">
                <label htmlFor="supplier-name">Supplier name</label>
                <input id="supplier-name" value={draft.supplierName} onChange={(event) => update("supplierName", event.target.value)} maxLength={160} placeholder="Optional" />
              </div>
              <div className="field">
                <label htmlFor="supplier-code">Supplier product code</label>
                <input id="supplier-code" value={draft.supplierProductCode} onChange={(event) => update("supplierProductCode", event.target.value)} maxLength={120} placeholder="Optional" />
              </div>
              <div className="field">
                <label htmlFor="purchase-currency">Purchase currency <em>Required</em></label>
                <input id="purchase-currency" value={draft.purchaseCurrency} onChange={(event) => update("purchaseCurrency", event.target.value.toUpperCase())} maxLength={3} placeholder="e.g. USD, CNY" required />
                <small>Use the supplier's currency code. This is not assumed to be ZMW.</small>
              </div>
              <div className="field">
                <label htmlFor="purchase-price">Purchase price</label>
                <input id="purchase-price" inputMode="decimal" value={draft.purchasePrice} onChange={(event) => update("purchasePrice", event.target.value)} placeholder="Optional" />
              </div>

              <div className="form-section-label field-full"><BadgeDollarSign aria-hidden="true" /> Zambia pricing estimates</div>
              <div className="field">
                <label htmlFor="landed-cost">Estimated landed cost · ZMW</label>
                <input id="landed-cost" inputMode="decimal" value={draft.estimatedLandedCostZmw} onChange={(event) => update("estimatedLandedCostZmw", event.target.value)} placeholder="Optional" />
              </div>
              <div className="field">
                <label htmlFor="selling-price">Selling price · ZMW</label>
                <input id="selling-price" inputMode="decimal" value={draft.sellingPriceZmw} onChange={(event) => update("sellingPriceZmw", event.target.value)} placeholder="Optional" />
              </div>
              <div className="field">
                <label htmlFor="reorder-threshold">Reorder threshold</label>
                <input id="reorder-threshold" type="number" min="0" step="1" value={draft.reorderThreshold} onChange={(event) => update("reorderThreshold", event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="product-unit">Unit <em>Required</em></label>
                <input id="product-unit" value={draft.unit} onChange={(event) => update("unit", event.target.value)} maxLength={40} required placeholder="e.g. piece, pack" />
              </div>
              <div className="field field-full">
                <label htmlFor="product-status">Product status</label>
                <select id="product-status" value={draft.status} onChange={(event) => update("status", event.target.value as ProductStatus)}>
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
              <div className="form-hint">
                Estimated landed cost and selling price are recorded in ZMW. Any profit or margin shown elsewhere is an estimate and should not be treated as actual profit.
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <span className="modal-footer-note">{product ? `Last updated ${formatDate(product.updatedAt)}` : "Fields marked required must be completed."}</span>
            <div className="modal-footer-actions">
              <button type="button" className="button button-secondary" disabled={saving} onClick={onClose}>Cancel</button>
              <button type="submit" className="button button-primary" disabled={saving}>
                {saving ? <RefreshCw aria-hidden="true" /> : <Check aria-hidden="true" />}
                {saving ? "Saving…" : product ? "Save changes" : "Create product"}
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}

function CategoryModal({
  category,
  onClose,
  onSaved,
}: {
  category: Category | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [draft, setDraft] = useState<CategoryDraft>(() => ({
    name: category?.name ?? "",
    description: category?.description ?? "",
    status: category?.status ?? "active",
  }));
  const [error, setError] = useState("");
  const [validation, setValidation] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setValidation("");
    if (!draft.name.trim()) {
      setValidation("Enter a category name.");
      return;
    }
    setSaving(true);
    try {
      if (category) {
        await updateCategory(category.id, {
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          status: draft.status,
        });
        onSaved(`${draft.name.trim()} updated.`);
      } else {
        await createCategory({
          name: draft.name.trim(),
          description: draft.description.trim() || null,
        });
        onSaved(`${draft.name.trim()} category created.`);
      }
    } catch (caught) {
      setError(displayError(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="modal modal-small" role="dialog" aria-modal="true" aria-labelledby="category-modal-title">
        <div className="modal-header">
          <div>
            <p className="eyebrow">{category ? "Catalogue structure" : "New group"}</p>
            <h2 id="category-modal-title">{category ? "Edit category" : "Add category"}</h2>
            <p>Use a name that makes product browsing easier.</p>
          </div>
          <button className="icon-button" aria-label="Close category form" disabled={saving} onClick={onClose}><X aria-hidden="true" /></button>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="modal-body">
            {error && <AlertMessage notice={{ kind: "error", message: error }} />}
            {validation && <AlertMessage notice={{ kind: "error", message: validation }} />}
            <div className="form-grid">
              <div className="field field-full">
                <label htmlFor="category-name">Category name <em>Required</em></label>
                <input
                  id="category-name"
                  autoFocus
                  value={draft.name}
                  onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                  maxLength={100}
                  required
                />
              </div>
              <div className="field field-full">
                <label htmlFor="category-description">Description</label>
                <textarea
                  id="category-description"
                  value={draft.description}
                  onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                  maxLength={500}
                  placeholder="Optional note about what belongs here"
                />
              </div>
              {category && (
                <div className="field field-full">
                  <label htmlFor="category-status">Category status</label>
                  <select id="category-status" value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as CategoryStatus }))}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              )}
              {!category && <div className="form-hint">New categories are created using the workspace's default active status.</div>}
            </div>
          </div>
          <div className="modal-footer">
            <span className="modal-footer-note">Category names are visible in the product catalogue.</span>
            <div className="modal-footer-actions">
              <button type="button" className="button button-secondary" disabled={saving} onClick={onClose}>Cancel</button>
              <button type="submit" className="button button-primary" disabled={saving}>
                {saving ? <RefreshCw aria-hidden="true" /> : <Check aria-hidden="true" />}
                {saving ? "Saving…" : category ? "Save changes" : "Create category"}
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
