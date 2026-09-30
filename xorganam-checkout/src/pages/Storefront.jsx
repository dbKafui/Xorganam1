import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { publicApi } from '../api/client'

function money(value) { return `GHS ${Number(value || 0).toFixed(2)}` }

export default function Storefront() {
  const { slug } = useParams()
  const [searchParams] = useSearchParams()
  const marketplaceEntry = searchParams.get('source') === 'marketplace'
  const [data, setData] = useState(null)
  const [cart, setCart] = useState({})
  const [branchId, setBranchId] = useState('')
  const [fulfillment, setFulfillment] = useState('PICKUP')
  const [address, setAddress] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('EGANOW')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [payment, setPayment] = useState(null)

  useEffect(() => {
    publicApi.getStorefront(slug).then((result) => {
      setData(result)
      if (result.branches?.[0]) setBranchId(result.branches[0].id)
    }).catch((requestError) => setError(requestError.message))
  }, [slug])

  useEffect(() => {
    if (!payment?.reference || payment.status !== 'PENDING_PAYMENT') return undefined
    let cancelled = false
    let attempts = 0
    const poll = async () => {
      if (cancelled) return
      try {
        const result = await publicApi.getStatus(payment.reference)
        if (cancelled) return
        const status = String(result.status || '').toUpperCase()
        if (['RECEIVED', 'SWEPT_INTERNAL', 'PAID_OUT', 'PARTIALLY_SETTLED'].includes(status)) {
          setPayment((current) => ({ ...current, status: 'PLACED' })); setNotice('Payment received. Your order is placed.'); return
        }
        if (status === 'FAILED') {
          setPayment((current) => ({ ...current, status: 'CANCELLED' })); setError(result.failureReason || 'Payment failed. The reservation is being released.'); return
        }
      } catch { /* Payment remains pending; the server expiry worker owns stock release. */ }
      attempts += 1
      if (attempts < 18) window.setTimeout(poll, 5000)
    }
    const timer = window.setTimeout(poll, 2500)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [payment?.reference, payment?.status])

  const products = data?.products || []
  const blocks = data?.storefront?.branding_config?.blocks || []
  const hasProductGrid = blocks.some((block) => block.type === 'product_grid')
  const total = useMemo(() => products.reduce((sum, product) => sum + Number(product.price) * Number(cart[product.id] || 0), 0), [products, cart])
  const theme = data?.storefront?.branding_config?.theme || {}

  function add(product) {
    setError(''); setNotice(''); setPayment(null)
    setCart((current) => ({ ...current, [product.id]: Number(current[product.id] || 0) + 1 }))
  }
  function changeQty(productId, value) {
    const quantity = Number(value)
    setCart((current) => {
      const next = { ...current }
      if (!quantity || quantity < 0) delete next[productId]
      else next[productId] = Math.min(100, quantity)
      return next
    })
  }

  async function checkout(event) {
    event.preventDefault(); setSubmitting(true); setError(''); setNotice('')
    const items = Object.entries(cart).map(([productId, quantity]) => ({ productId, quantity }))
    try {
      const createOrder = marketplaceEntry ? publicApi.createMarketplaceOrder : publicApi.createStorefrontOrder
      const result = await createOrder(slug, {
        items, customerPhone, customerName,
        fulfillmentType: fulfillment, fulfillmentAddress: fulfillment === 'DELIVERY' ? address : undefined,
        merchantId: fulfillment === 'PICKUP' ? branchId : undefined, paymentMethod
      })
      setPayment({ ...result, reference: result.reference || null })
      if (result.reference) setNotice(result.message || 'Payment prompt sent. Approve it on your phone.')
      else setNotice(result.status === 'PLACED' ? 'Credit purchase confirmed. Your order is placed.' : 'Order created.')
      setCart({})
    } catch (requestError) { setError(requestError.message) }
    finally { setSubmitting(false) }
  }

  if (!data && !error) return <main className="storefront-shell"><p>Loading storefront…</p></main>
  if (!data) return <main className="storefront-shell"><h1>Storefront unavailable</h1><p>{error}</p><Link to="/marketplace">Browse marketplace</Link></main>

  function ProductCard({ product }) {
    const image = product.media?.[0]
    return <article className="store-product-card">
      {image ? <img src={image.url} alt={image.altText || product.name} loading="lazy" /> : <div className="store-product-placeholder">{product.listing_type === 'SERVICE' ? 'Service' : 'Product'}</div>}
      <div className="store-product-copy"><h3>{product.name}</h3><p>{product.description}</p><strong>{money(product.price)}</strong>
        <button className="btn btn-primary" type="button" onClick={() => add(product)}>Add to cart</button>
      </div>
    </article>
  }

  return <main className="storefront-shell" style={{ '--store-primary': theme.primaryColor || '#1a2b3c', '--store-font': theme.font || 'Inter' }}>
    <nav className="store-topbar"><Link to="/marketplace">Marketplace</Link><Link to="/my-orders">My orders & reviews</Link></nav>
    <header className="store-header">
      {theme.logoUrl && <img className="store-logo" src={theme.logoUrl} alt={`${data.storefront.vendor_name} logo`} />}
      <div><p className="eyebrow">Vendor storefront</p><h1>{data.storefront.vendor_name}</h1></div>
    </header>
    {blocks.map((block, index) => {
      if (block.type === 'hero') return <section key={index} className="store-hero" style={{ backgroundColor: block.props.backgroundColor, color: block.props.textColor, ...block.props.style, backgroundImage: block.props.imageUrl ? `linear-gradient(90deg,rgba(0,0,0,.48),rgba(0,0,0,.08)),url("${block.props.imageUrl}")` : undefined }}>
        <h2>{block.props.headline}</h2>{block.props.subheadline && <p>{block.props.subheadline}</p>}
      </section>
      if (block.type === 'rich_text') return <section key={index} className="store-rich-text" style={{ color: block.props.textColor, backgroundColor: block.props.backgroundColor, ...block.props.style }} dangerouslySetInnerHTML={{ __html: block.props.html }} />
      if (block.type === 'product_grid') {
        const blockProducts = products.filter((product) => (!block.props.categoryId || product.category_id === block.props.categoryId) && (!block.props.productIds || block.props.productIds.includes(product.id)))
        return <section key={index} className="store-block-grid" style={{ backgroundColor: block.props.backgroundColor, color: block.props.textColor, ...block.props.style }}><h2>{block.props.title || 'Shop products'}</h2><div className="store-products" style={{ '--store-columns': block.props.columns || 3 }}>{blockProducts.map((product) => <ProductCard product={product} key={product.id} />)}</div></section>
      }
      return null
    })}
    {!hasProductGrid && <section className="store-block-grid"><h2>Products</h2>{products.length ? <div className="store-products">{products.map((product) => <ProductCard product={product} key={product.id} />)}</div> : <p>No products are currently listed.</p>}</section>}
    <section className="store-reviews"><h2>Customer reviews</h2>{data.reviews.length ? data.reviews.map((review) => <article className="store-review" key={review.id}><strong>{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</strong><p>{review.comment}</p></article>) : <p>No approved reviews yet.</p>}<Link to="/my-orders">Leave a verified-purchase review</Link></section>
    {Object.keys(cart).length > 0 && <aside className="store-cart card">
      <div className="portal-header"><h2>Your cart</h2><strong>{money(total)}</strong></div>
      <form onSubmit={checkout}>
        {products.filter((product) => cart[product.id]).map((product) => <div className="store-cart-line" key={product.id}><label>{product.name} · {money(product.price)}</label><input aria-label={`Quantity for ${product.name}`} type="number" min="0" max="100" value={cart[product.id]} onChange={(e) => changeQty(product.id, e.target.value)} /></div>)}
        <div className="two-col">
          <div className="field"><label>Fulfillment</label><select value={fulfillment} onChange={(e) => setFulfillment(e.target.value)}><option value="PICKUP">Pickup</option><option value="DELIVERY" disabled={!data.storefront.default_fulfillment_branch_id}>Delivery</option></select></div>
          {fulfillment === 'PICKUP' ? <div className="field"><label>Pickup branch</label><select required value={branchId} onChange={(e) => setBranchId(e.target.value)}>{data.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.display_name}</option>)}</select></div> : <div className="field"><label>Delivery address</label><input required maxLength="1000" value={address} onChange={(e) => setAddress(e.target.value)} /></div>}
          <div className="field"><label>Your mobile number</label><input required inputMode="tel" autoComplete="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="0551234567" /></div>
          <div className="field"><label>Name (optional)</label><input maxLength="160" value={customerName} onChange={(e) => setCustomerName(e.target.value)} /></div>
        </div>
        {data.creditDefaults?.enabled && <div className="field"><label>Payment method</label><select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}><option value="EGANOW">Pay now with Eganow</option><option value="CREDIT">Hire-purchase ({data.creditDefaults.installment_count} {String(data.creditDefaults.installment_frequency).toLowerCase()} installments; {data.creditDefaults.down_payment_percent}% down payment)</option></select></div>}
        {error && <div className="status-banner error" role="alert">{error}</div>}{notice && <div className="status-banner success" role="status">{notice}</div>}
        {payment && <div className="order-confirmation"><strong>Order {payment.orderId}</strong><span>Status: {payment.status}</span>{payment.paymentAmount > 0 && <span>Payment prompt amount: {money(payment.paymentAmount)}</span>}<Link to="/my-orders">Track your order</Link></div>}
        <button className="btn btn-primary" disabled={submitting || !branchId && fulfillment === 'PICKUP'}>{submitting ? 'Starting checkout…' : `Place order · ${money(total)}`}</button>
      </form>
    </aside>}
  </main>
}
