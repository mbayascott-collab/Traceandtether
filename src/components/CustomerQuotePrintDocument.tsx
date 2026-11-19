import type { CustomerQuote } from "../lib/api";
import { isCustomerQuoteExpired } from "../../shared/customer-quote-expiry";

const companyName = "Trace and Tether Craft Studio Limited";
const companyAddress = "164 Mpundu Street, Chelston Extension, Lusaka, Zambia";
const companyEmail = "traceandtether@gmail.com";
const companyPhone = "+260-0977-101-967";

interface CustomerQuotePrintDocumentProps {
  quote: CustomerQuote;
  logoSrc: string;
}

const money = (value: string) => `ZMW ${Number(value).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function CustomerQuotePrintDocument({ quote, logoSrc }: CustomerQuotePrintDocumentProps) {
  const quoteDate = (value: string) => new Date(value).toLocaleDateString("en-ZM", { day: "numeric", month: "long", year: "numeric" });
  const statusLabel = quote.status.charAt(0).toUpperCase() + quote.status.slice(1);

  return <article className="customer-quote-document" id="customer-quote-print">
    <header className="customer-quote-document-header">
      <div className="customer-quote-document-brand">
        <img src={logoSrc} alt={`${companyName} logo`} />
        <div><strong>{companyName}</strong><small>{companyAddress}<br />{companyEmail}<br />{companyPhone}</small></div>
      </div>
      <div className="customer-quote-document-title">
        <div><span className="customer-quote-document-kicker">CUSTOMER QUOTATION</span><h1>{quote.quoteNumber}</h1></div>
        <div className="customer-quote-document-meta">
          <div><span>Quote date</span><strong>{quoteDate(quote.createdAt)}</strong></div>
          <div><span>Status</span><strong className="customer-quote-status">{statusLabel}</strong></div>
          <div>
            <span>Valid until</span>
            <strong>{quote.validUntil ? quoteDate(quote.validUntil) : "No expiry date"}</strong>
            {isCustomerQuoteExpired(quote.validUntil) && <em className="customer-quote-expired">Expired</em>}
          </div>
        </div>
      </div>
    </header>
    <section className="customer-quote-document-customer">
      <span>PREPARED FOR</span><strong>{quote.customerName}</strong>
      {quote.deliveryAddress && <p>{quote.deliveryAddress}</p>}
    </section>
    <table className="customer-quote-document-table">
      <thead><tr><th>Product</th><th>SKU</th><th className="quote-number-cell">Qty</th><th className="quote-number-cell">Unit price</th><th className="quote-number-cell">Amount</th></tr></thead>
      <tbody>{quote.lines.map((line) => <tr key={line.id}>
        <td>{line.productName}</td><td>{line.sku}</td><td className="quote-number-cell">{line.quantity}</td><td className="quote-number-cell">{money(line.unitPriceZmw)}</td><td className="quote-number-cell">{money(line.lineTotalZmw)}</td>
      </tr>)}</tbody>
    </table>
    {quote.notes && <section className="customer-quote-document-notes"><span>NOTES</span><p>{quote.notes}</p></section>}
    <div className="customer-quote-document-summary">
      <div className="customer-quote-document-total"><span>Total (ZMW)</span><strong>{money(quote.totalZmw)}</strong></div>
      <div className="customer-quote-document-signoff">
        <section className="customer-quote-document-acceptance"><strong>Customer approval</strong><div><span>Name and signature</span><span>Date</span></div></section>
        <footer className="customer-quote-document-footer">All prices are in ZMW. Quote reference: {quote.quoteNumber}</footer>
      </div>
    </div>
  </article>;
}
