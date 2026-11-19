import { formatSupplierDeliveryVariance, type SupplierReportCsvData } from "../../shared/supplier-report-csv";

type Props = { report: SupplierReportCsvData };

const money = (value: string | null | undefined) => value == null
  ? "—"
  : `ZMW ${Number(value).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en", {
  month: "long", year: "numeric", timeZone: "UTC",
});

export default function SupplierSpendPrintDocument({ report }: Props) {
  return <article id="supplier-spend-print-document" className="supplier-spend-print-document">
    <header className="supplier-spend-print-header">
      <p className="supplier-spend-print-eyebrow">Supplier report · ZMW</p>
      <h1>Supplier spend and delivery</h1>
      <p className="supplier-spend-print-period">
        {report.period.from ?? "All dates"} to {report.period.to ?? "All dates"}
      </p>
      <p className="supplier-spend-print-dates">
        Goods ordered use purchase-order dates. Import costs use recorded expense dates. Supplier payments use payment dates and are shown separately.
      </p>
    </header>

    <section className="supplier-spend-print-section supplier-spend-print-overview">
      <h2>Report totals</h2>
      <div className="supplier-spend-print-total-grid">
        <div><span>Goods ordered</span><strong>{money(report.totals.orderedGoodsZmw)}</strong></div>
        <div><span>Import costs recorded</span><strong>{money(report.totals.importCostsZmw)}</strong></div>
        <div><span>Supplier payments recorded</span><strong>{money(report.totals.paymentsZmw)}</strong></div>
        <div><span>Orders in period</span><strong>{report.totals.orders}</strong></div>
      </div>
      <div className="supplier-spend-print-delivery-summary">
        <div><span>Matched delivery dates</span><strong>{report.totals.measuredDeliveryOrders}</strong></div>
        <div><span>On time</span><strong>{report.totals.onTimeOrders}</strong></div>
        <div><span>Late</span><strong>{report.totals.lateOrders}</strong></div>
        <div><span>Missing expected date</span><strong>{report.totals.missingExpectedDateOrders}</strong></div>
        <div><span>Missing actual date</span><strong>{report.totals.missingActualDateOrders}</strong></div>
        <div><span>Incomplete / open</span><strong>{report.totals.incompleteDeliveryOrders}</strong></div>
        <div><span>Overdue open</span><strong>{report.totals.overdueOpenOrders}</strong></div>
      </div>
      <p className="supplier-spend-print-unallocated">
        {money(report.totals.unallocatedImportCostsZmw)} in import costs could not be assigned to a supplier and is not included in supplier rows.
      </p>
    </section>

    <section className="supplier-spend-print-section">
      <h2>Supplier totals and delivery record</h2>
      <table className="supplier-spend-print-table supplier-spend-print-suppliers">
        <thead>
          <tr>
            <th scope="col" rowSpan={2}>Supplier</th>
            <th scope="colgroup" colSpan={4}>Spend · ZMW</th>
            <th scope="colgroup" colSpan={8}>Delivery record</th>
          </tr>
          <tr>
            <th scope="col">Orders</th><th scope="col">Goods</th><th scope="col">Import costs</th><th scope="col">Payments</th>
            <th scope="col">Matched</th><th scope="col">On time</th><th scope="col">Late</th>
            <th scope="col">Missing expected</th><th scope="col">Missing actual</th><th scope="col">Incomplete / open</th>
            <th scope="col">Overdue open</th><th scope="col">Average variance</th>
          </tr>
        </thead>
        <tbody>
          {report.suppliers.map((supplier, index) => <tr key={`${supplier.name}-${index}`}>
            <th scope="row">{supplier.name}</th>
            <td>{supplier.orders}</td><td>{money(supplier.orderedGoodsZmw)}</td>
            <td>{money(supplier.importCostsZmw)}</td><td>{money(supplier.paymentsZmw)}</td>
            <td>{supplier.measuredDeliveryOrders}</td><td>{supplier.onTimeOrders}</td><td>{supplier.lateOrders}</td>
            <td>{supplier.missingExpectedDateOrders}</td><td>{supplier.missingActualDateOrders}</td>
            <td>{supplier.incompleteDeliveryOrders}</td><td>{supplier.overdueOpenOrders}</td>
            <td>{formatSupplierDeliveryVariance(supplier.averageDeliveryVarianceDays)}</td>
          </tr>)}
          {!report.suppliers.length && <tr><td colSpan={13}>No supplier orders in this period.</td></tr>}
        </tbody>
        {report.suppliers.length > 0 && <tfoot><tr>
          <th scope="row">Total</th>
          <td>{report.totals.orders}</td><td>{money(report.totals.orderedGoodsZmw)}</td>
          <td>{money(report.totals.importCostsZmw)}</td><td>{money(report.totals.paymentsZmw)}</td>
          <td>{report.totals.measuredDeliveryOrders}</td><td>{report.totals.onTimeOrders}</td><td>{report.totals.lateOrders}</td>
          <td>{report.totals.missingExpectedDateOrders}</td><td>{report.totals.missingActualDateOrders}</td>
          <td>{report.totals.incompleteDeliveryOrders}</td><td>{report.totals.overdueOpenOrders}</td><td>—</td>
        </tr></tfoot>}
      </table>
      <p className="supplier-spend-print-note">
        Average variance uses matched dates only. A positive value is late; a negative value is early.
      </p>
    </section>

    <section className="supplier-spend-print-section">
      <h2>Monthly buying and import costs</h2>
      <p className="supplier-spend-print-note">
        Goods ordered by purchase-order date · Import costs by recorded expense date · Payments by payment date, shown separately
      </p>
      <table className="supplier-spend-print-table supplier-spend-print-monthly">
        <thead><tr><th scope="col">Month</th><th scope="col">Goods ordered</th><th scope="col">Import costs</th><th scope="col">Supplier payments · separate</th></tr></thead>
        <tbody>
          {report.monthlySpend.map((month) => <tr key={month.month}>
            <th scope="row">{monthLabel(month.month)}</th>
            <td>{money(month.orderedGoodsZmw)}</td><td>{money(month.importCostsZmw)}</td><td>{money(month.paymentsZmw)}</td>
          </tr>)}
          {!report.monthlySpend.length && <tr><td colSpan={4}>No supplier costs or payments in this period.</td></tr>}
        </tbody>
      </table>
    </section>

    <section className="supplier-spend-print-section">
      <h2>Monthly costs by supplier</h2>
      <p className="supplier-spend-print-note">
        Shared shipment expenses are allocated across linked supplier orders once. Unassigned costs are excluded from supplier rows.
      </p>
      <table className="supplier-spend-print-table supplier-spend-print-monthly">
        <thead><tr><th scope="col">Month</th><th scope="col">Supplier</th><th scope="col">Goods ordered</th><th scope="col">Allocated import costs</th></tr></thead>
        <tbody>
          {report.monthlySpend.flatMap((month) => month.suppliers.length
            ? [
              ...month.suppliers.map((supplier) => <tr key={`${month.month}-${supplier.supplierId}`}>
                <th scope="row">{monthLabel(month.month)}</th><td>{supplier.supplierName}</td>
                <td>{money(supplier.orderedGoodsZmw)}</td><td>{money(supplier.importCostsZmw)}</td>
              </tr>),
              <tr key={`${month.month}-supplier-total`}>
                <th scope="row">{monthLabel(month.month)} supplier-allocated total</th><td />
                <td>{money(month.suppliers.reduce((sum, supplier) => sum + Number(supplier.orderedGoodsZmw), 0).toFixed(2))}</td>
                <td>{money(month.suppliers.reduce((sum, supplier) => sum + Number(supplier.importCostsZmw), 0).toFixed(2))}</td>
              </tr>,
            ]
            : [<tr key={`${month.month}-supplier-empty`}>
              <th scope="row">{monthLabel(month.month)}</th><td>No supplier costs assigned this month.</td>
              <td>{money("0.00")}</td><td>{money("0.00")}</td>
            </tr>])}
          {!report.monthlySpend.length && <tr><td colSpan={4}>No supplier costs in this period.</td></tr>}
        </tbody>
      </table>
    </section>

    <section className="supplier-spend-print-section">
      <h2>Shipment receipt dates</h2>
      <p className="supplier-spend-print-note">Only dates recorded on each shipment are shown; missing dates are not inferred.</p>
      <table className="supplier-spend-print-table supplier-spend-print-shipments">
        <thead><tr>
          <th scope="col">Supplier</th><th scope="col">Purchase order</th><th scope="col">Shipment</th>
          <th scope="col">Status</th><th scope="col">Expected receipt</th><th scope="col">Actual receipt</th>
        </tr></thead>
        <tbody>
          {report.shipments.map((shipment, index) => <tr key={`${shipment.shipmentId}-${shipment.supplierId}-${index}`}>
            <th scope="row">{shipment.supplierName}</th><td>{shipment.orderNumber}</td>
            <td>{shipment.shipmentReference || `#${shipment.shipmentId}`}</td><td>{shipment.status}</td>
            <td>{shipment.expectedAt ?? "—"}</td><td>{shipment.receivedAt ?? "—"}</td>
          </tr>)}
          {!report.shipments.length && <tr><td colSpan={6}>No supplier shipments for orders in this period.</td></tr>}
        </tbody>
      </table>
    </section>
    <footer className="supplier-spend-print-footer">
      Order values use each purchase order’s recorded exchange rate. Shared shipment costs are allocated across linked supplier orders using the recorded allocation basis and counted once in the month of the recorded expense date. Supplier payments are reported separately and are not costs. Delivery summaries use a shipment’s expected date, or its purchase order’s expected date when the shipment date is blank; actual receipt dates are never inferred.
    </footer>
  </article>;
}
