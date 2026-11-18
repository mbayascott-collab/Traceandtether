import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Minus, Plus, ShoppingBag } from "lucide-react";
import { Link } from "wouter";

type ShopProduct = { id: number; name: string; description: string | null; unit: string; sellingPriceZmw: string };
type Cart = Record<number, number>;

function money(value: string) {
  return `ZMW ${Number(value).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function PublicShop() {
  const [products, setProducts] = useState<ShopProduct[]>([]);
  const [cart, setCart] = useState<Cart>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [orderNumber, setOrderNumber] = useState("");
  const [challenge, setChallenge] = useState("");
  const [website, setWebsite] = useState("");
  const [customer, setCustomer] = useState({ name: "", phone: "", email: "", address: "", notes: "" });

  useEffect(() => {
    fetch("/api/shop/products")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load products.");
        setProducts(data.products);
        setChallenge(data.challenge);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load products."))
      .finally(() => setLoading(false));
  }, []);

  const cartProducts = useMemo(() => products.filter((product) => cart[product.id]), [products, cart]);
  const total = cartProducts.reduce((sum, product) => sum + Number(product.sellingPriceZmw) * cart[product.id], 0);

  function setQuantity(product: ShopProduct, quantity: number) {
    setCart((current) => {
      const next = { ...current };
      if (quantity < 1) delete next[product.id];
      else next[product.id] = Math.min(quantity, 99);
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/shop/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...customer,
          challenge,
          website,
          lines: cartProducts.map((product) => ({ productId: product.id, quantity: cart[product.id] })),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not submit your order.");
      setOrderNumber(data.orderNumber);
      setCart({});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not submit your order.");
      try {
        const refresh = await fetch("/api/shop/products");
        const data = await refresh.json();
        if (!refresh.ok || typeof data.challenge !== "string") throw new Error("Could not refresh the order form.");
        setChallenge(data.challenge);
      } catch {
        setChallenge("");
        setError("Could not refresh the order form. Please reload the shop and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="public-shop">
      <header className="shop-header">
        <Link href="/" className="shop-brand"><span className="shop-brand-mark">T</span> TRACE&TETHER</Link>
        <a className="shop-cart-link" href="#checkout"><ShoppingBag size={18} /> Bag <b>{Object.values(cart).reduce((a, b) => a + b, 0)}</b></a>
      </header>
      <section className="shop-hero">
        <div>
          <p className="shop-eyebrow">TRACE&TETHER · ZAMBIA</p>
          <h1>Good products.<br /><em>Fair prices.</em></h1>
          <p>Browse our current selection and send an order request. We’ll contact you to confirm availability, delivery, and payment.</p>
        </div>
        <div className="shop-hero-stamp">LOCAL<br />ORDERS<br /><span>IN ZMW</span></div>
      </section>
      <section className="shop-catalog" aria-labelledby="shop-catalog-heading">
        <div className="shop-section-heading"><div><span className="shop-eyebrow">THE CATALOGUE</span><h2 id="shop-catalog-heading">Available now</h2></div><span>{products.length} items</span></div>
        {error && <div className="shop-error" role="alert">{error}</div>}
        {loading ? <p className="shop-empty">Loading the catalogue…</p> : products.length === 0 ? (
          <div className="shop-empty"><ShoppingBag /><h3>Nothing is available just yet</h3><p>Please check back soon.</p></div>
        ) : (
          <div className="shop-product-grid">
            {products.map((product, index) => (
              <article className="shop-product-card" key={product.id}>
                <div className={`shop-product-art art-${index % 4}`}><span>T&amp;T</span></div>
                <div className="shop-product-info">
                  <span className="shop-stock">AVAILABLE</span>
                  <h3>{product.name}</h3>
                  {product.description && <p>{product.description}</p>}
                  <div className="shop-product-bottom"><strong>{money(product.sellingPriceZmw)}</strong><button type="button" className="shop-add-button" onClick={() => setQuantity(product, (cart[product.id] ?? 0) + 1)} aria-label={`Add ${product.name} to bag`}><Plus /></button></div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {cartProducts.length > 0 && (
        <section className="shop-checkout" id="checkout">
          <div className="shop-checkout-summary">
            <span className="shop-eyebrow">YOUR ORDER</span><h2>Review your bag</h2>
            {cartProducts.map((product) => (
              <div className="shop-cart-row" key={product.id}>
                <div><strong>{product.name}</strong><span>{money(product.sellingPriceZmw)} / {product.unit}</span></div>
                <div className="shop-quantity"><button type="button" aria-label={`Remove one ${product.name}`} onClick={() => setQuantity(product, cart[product.id] - 1)}><Minus /></button><span>{cart[product.id]}</span><button type="button" aria-label={`Add one ${product.name}`} onClick={() => setQuantity(product, cart[product.id] + 1)}><Plus /></button></div>
              </div>
            ))}
            <div className="shop-total"><span>Estimated total</span><strong>{money(total.toFixed(2))}</strong></div>
            <p className="shop-small-note">Delivery charges and final availability are confirmed before you pay.</p>
          </div>
          <form className="shop-order-form" onSubmit={submit}>
            <span className="shop-eyebrow">SEND ORDER REQUEST</span><h2>Where can we reach you?</h2>
            <label className="shop-honeypot" aria-hidden="true">Leave this field empty<input name="website" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" /></label>
            <label>Your name<input required maxLength={160} value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} /></label>
            <label>Phone number<input required type="tel" maxLength={60} value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} /></label>
            <label>Email <span>(optional)</span><input type="email" maxLength={254} value={customer.email} onChange={(e) => setCustomer({ ...customer, email: e.target.value })} /></label>
            <label>Delivery address <span>(optional)</span><textarea rows={2} maxLength={5000} value={customer.address} onChange={(e) => setCustomer({ ...customer, address: e.target.value })} /></label>
            <label>Note <span>(optional)</span><textarea rows={2} maxLength={1000} value={customer.notes} onChange={(e) => setCustomer({ ...customer, notes: e.target.value })} /></label>
            <button className="shop-submit" type="submit" disabled={submitting}>{submitting ? "Sending…" : "Send order request"} <ArrowRight /></button>
            <p className="shop-small-note">No online payment is taken. Your order is not confirmed until we contact you.</p>
          </form>
        </section>
      )}
      {orderNumber && (
        <div className="shop-success" role="status">
          <button className="shop-success-close" onClick={() => setOrderNumber("")} aria-label="Close confirmation">×</button>
          <span className="shop-eyebrow">REQUEST RECEIVED</span><h2>Thank you, we’ll be in touch.</h2>
          <p>Your reference is <strong>{orderNumber}</strong>. We’ll contact you to confirm stock, delivery, and payment. No payment has been taken.</p>
        </div>
      )}
      <footer className="shop-footer"><span>TRACE&TETHER</span><span>Order requests only · Payment confirmed separately</span><Link href="/dashboard"><ArrowLeft size={15} /> Owner sign in</Link></footer>
    </main>
  );
}
