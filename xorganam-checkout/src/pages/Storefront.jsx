import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { publicApi } from '../api/client'
import { clearIdempotencyKey, getOrCreateIdempotencyKey } from '../lib/idempotency'
import { classifyPaymentStatus } from '../lib/statusOutcome'
import { MOMO_CHANNELS } from '../constants/paymentOptions.js'

import { decimalAmountFromMinorUnits, formatCurrencyAmount, multiplyDecimalByInteger } from '../../../shared/currency.js'
function money(value) { return formatCurrencyAmount(value ?? '—', 'GHS') }

function restoreOrderAttempt(slug) {
  try {
    const value = sessionStorage.getItem(`xorganam_store_order:${slug}`)
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

export default function Storefront() {
  const { slug } = useParams()
  const [searchParams] = useSearchParams()
  const marketplaceEntry = searchParams.get('source') === 'marketplace'
  const [data, setData] = useState(null)
  const [cart, setCart] = useState({})
  const [selectedCategoryId, setSelectedCategoryId] = useState('')
  const [branchId, setBranchId] = useState('')
  const [fulfillment, setFulfillment] = useState('PICKUP')
  const [address, setAddress] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('EGANOW')
  const [collectionMethod, setCollectionMethod] = useState('MOMO')
  const [networkProvider, setNetworkProvider] = useState('')
  const [card, setCard] = useState({ number: '', name: '', month: '', year: '', cvv: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [payment, setPayment] = useState(() => restoreOrderAttempt(slug))
  const [cardRedirectHtml, setCardRedirectHtml] = useState('')
  const idempotencyStorageKey = `xorganam_store_order_key:${slug}`
  const idempotencyKey = useRef(sessionStorage.getItem(idempotencyStorageKey))
  const attemptStorageKey = `xorganam_store_order:${slug}`

  useEffect(() => {
    let current = true
    setData(null)
    setError('')
    setBranchId('')
    setCart({})
    setSelectedCategoryId('')
    setPayment(restoreOrderAttempt(slug))
    setCardRedirectHtml('')
    setNotice('')
    setFulfillment('PICKUP')
    setAddress('')
    setCustomerPhone('')
    setCustomerName('')
    setPaymentMethod('EGANOW')
    setCollectionMethod('MOMO')
    setNetworkProvider('')
    setCard({ number: '', name: '', month: '', year: '', cvv: '' })
    idempotencyKey.current = null
    publicApi.getStorefront(slug).then((result) => {
      if (!current) return
      setData(result)
      if (result.branches?.[0]) setBranchId(result.branches[0].id)
    }).catch((requestError) => {
      if (current) setError(requestError.message)
    })
    return () => { current = false }
  }, [slug])

  useEffect(() => {
    if (!payment) {
      sessionStorage.removeItem(attemptStorageKey)
      return
    }
    const safePaymentState = {
      orderId: payment.orderId,
      status: payment.status,
      totalAmount: payment.totalAmount,
      paymentAmount: payment.paymentAmount,
      paymentMethod: payment.paymentMethod,
      reference: payment.reference,
      message: payment.message
    }
    sessionStorage.setItem(attemptStorageKey, JSON.stringify(safePaymentState))
  }, [payment, attemptStorageKey])

  useEffect(() => {
    setPaymentMethod(data?.creditDefaults?.enabled ? 'CREDIT' : 'EGANOW')
  }, [slug, data?.creditDefaults?.enabled])

  useEffect(() => {
    if (!payment?.reference || payment.status !== 'PENDING_PAYMENT') return undefined
    let cancelled = false
    let attempts = 0
    const poll = async () => {
      if (cancelled) return
      try {
        const result = await publicApi.getStatus(payment.reference)
        if (cancelled) return
        const outcome = classifyPaymentStatus({ status: result.status, failureReason: result.failureReason })

        if (outcome.state === 'success') {
          setPayment((current) => ({ ...current, status: 'PLACED' })); setCart({}); setNotice('Payment received. Your order is placed.')
          idempotencyKey.current = null
          clearIdempotencyKey(idempotencyStorageKey)
          return
        }
        if (outcome.state === 'partial') {
          setPayment((current) => ({ ...current, status: 'PLACED' })); setCart({}); setNotice(outcome.message)
          idempotencyKey.current = null
          clearIdempotencyKey(idempotencyStorageKey)
          return
        }
        if (['failed', 'blocked', 'manual-reconciliation'].includes(outcome.state)) {
          setPayment((current) => ({ ...current, status: 'CANCELLED' })); setError(outcome.message)
          idempotencyKey.current = null
          clearIdempotencyKey(idempotencyStorageKey)
          return
        }
      } catch { /* Payment remains pending; the server expiry worker owns stock release. */ }
      attempts += 1
      if (attempts < 18) window.setTimeout(poll, 5000)
    }
    const timer = window.setTimeout(poll, 2500)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [payment?.reference, payment?.status])

  const allProducts = data?.products || []
  const products = selectedCategoryId ? allProducts.filter((product) => product.storefront_category_id === selectedCategoryId) : allProducts
  const blocks = data?.storefront?.branding_config?.blocks || []
  const hasProductGrid = blocks.some((block) => block.type === 'product_grid')
  const total = useMemo(() => {
    let minorUnits = 0n
    for (const product of allProducts) {
      const quantity = cart[product.id] || 0
      const line = multiplyDecimalByInteger(product.price, quantity, 'GHS')
      if (line === null) return null
      minorUnits += BigInt(line)
    }
    return decimalAmountFromMinorUnits(minorUnits.toString(), 'GHS')
  }, [allProducts, cart])
  const theme = data?.storefront?.branding_config?.theme || {}
  const inventoryBranchId = fulfillment === 'DELIVERY' ? data?.storefront?.default_fulfillment_branch_id : branchId

  function stockFor(product) {
    const stock = product.stock_by_branch?.find((item) => item.merchantId === inventoryBranchId)
    if (!stock) return { available: false, quantity: 0, unlimited: false }
    if (stock.unlimitedStock) return { available: true, quantity: 100, unlimited: true }
    const quantity = Math.max(0, Number(stock.quantityAvailable) || 0)
    return { available: quantity > 0, quantity: Math.min(100, quantity), unlimited: false }
  }

  function add(product) {
    if (payment?.status === 'PENDING_PAYMENT') return
    const stock = stockFor(product)
    setError(''); setNotice(''); setPayment(null)
    idempotencyKey.current = null
    clearIdempotencyKey(idempotencyStorageKey)
    if (!stock.available) return
    setCart((current) => ({ ...current, [product.id]: Math.min(stock.quantity, 100, Number(current[product.id] || 0) + 1) }))
  }
  function changeQty(productId, value) {
    const quantity = Math.trunc(Number(value))
    const product = allProducts.find((item) => item.id === productId)
    const maxQuantity = product ? stockFor(product).quantity : 100
    setCart((current) => {
      const next = { ...current }
      if (!quantity || quantity < 0 || maxQuantity <= 0) delete next[productId]
      else next[productId] = Math.min(100, maxQuantity, quantity)
      return next
    })
  }

  async function checkout(event) {
    event.preventDefault(); setSubmitting(true); setError(''); setNotice('')
    if (payment?.status === 'PENDING_PAYMENT') {
      setSubmitting(false)
      setError('This order payment is still pending. Check its status before starting another payment.')
      return
    }
    const unavailable = allProducts.find((product) => cart[product.id] && Number(cart[product.id]) > stockFor(product).quantity)
    if (unavailable) {
      setSubmitting(false)
      setError(`${unavailable.name} no longer has enough stock at the selected fulfillment location.`)
      return
    }
    const items = Object.entries(cart).map(([productId, quantity]) => ({ productId, quantity }))
    try {
      const createOrder = marketplaceEntry ? publicApi.createMarketplaceOrder : publicApi.createStorefrontOrder
      if (!idempotencyKey.current) idempotencyKey.current = getOrCreateIdempotencyKey(idempotencyStorageKey)
      const result = await createOrder(slug, {
        items, customerPhone, customerName,
        fulfillmentType: fulfillment, fulfillmentAddress: fulfillment === 'DELIVERY' ? address : undefined,
        merchantId: fulfillment === 'PICKUP' ? branchId : undefined, paymentMethod, collectionMethod,
        network: collectionMethod === 'MOMO' ? networkProvider || undefined : undefined,
        ...(collectionMethod === 'CARD' ? { cardNumber: card.number, cardholderName: card.name, expiryDateMonth: Number(card.month), expiryDateYear: card.year.slice(-2), cvv: card.cvv } : {})
      }, idempotencyKey.current)
      if (result.redirectHtml) {
        try { setCardRedirectHtml(decodeURIComponent(escape(atob(result.redirectHtml)))) } catch { setCardRedirectHtml(atob(result.redirectHtml)) }
      } else setCardRedirectHtml('')
      setPayment({ ...result, reference: result.reference || null })
      if (result.status === 'CANCELLED' || result.status === 'PLACED') {
        idempotencyKey.current = null
        clearIdempotencyKey(idempotencyStorageKey)
      }
      if (result.reference) setNotice(result.message || 'Payment prompt sent. Approve it on your phone.')
      else setNotice(result.status === 'PLACED' ? 'Credit purchase confirmed. Your order is placed.' : 'Order created.')
      if (result.status === 'PLACED') setCart({})
    } catch (requestError) {
      setError(requestError.message)
      if (requestError.status >= 400 && requestError.status < 500 && requestError.status !== 409) {
        idempotencyKey.current = null
        clearIdempotencyKey(idempotencyStorageKey)
      }
    }
    finally { setSubmitting(false) }
  }

  if (!data && !error) return <main className="storefront-shell"><p>Loading storefront…</p></main>
  if (!data) return <main className="storefront-shell"><h1>Storefront unavailable</h1><p>{error}</p><Link to="/marketplace">Browse marketplace</Link></main>

  function ProductCard({ product }) {
    const gallery = product.media || []
    const stock = stockFor(product)
    const quantityInCart = Number(cart[product.id] || 0)
    return <article className="store-product-card">
      {gallery.length ? <div className="store-product-images">{gallery.map((image) => <img src={image.url} alt={image.altText || product.name} loading="lazy" key={image.id || image.position || image.url} />)}</div> : <div className="store-product-placeholder">{product.listing_type === 'SERVICE' ? 'Service' : 'Product'}</div>}
      <div className="store-product-copy">{product.storefront_category_name && <span className="store-category-tag">{product.storefront_category_name}</span>}<h3>{product.name}</h3><p>{product.description}</p><strong>{money(product.price)}</strong>
        {Object.keys(product.specifications || {}).length > 0 && <dl className="store-product-specs">{Object.entries(product.specifications).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
        <small>{!stock.available ? 'Out of stock at this location' : stock.unlimited ? 'Available' : `${stock.quantity} available`}</small>
        <button className="btn btn-primary" type="button" disabled={!stock.available || quantityInCart >= stock.quantity} onClick={() => add(product)}>{!stock.available ? 'Unavailable' : quantityInCart >= stock.quantity ? 'Stock limit reached' : 'Add to cart'}</button>
      </div>
    </article>
  }

  return <main className="storefront-shell" style={{ '--store-primary': theme.primaryColor || '#1a2b3c', '--store-font': theme.font || 'Inter' }}>
    <nav className="store-topbar"><Link to="/marketplace">Marketplace</Link><Link to="/my-orders">My orders & reviews</Link></nav>
    <header className="store-header">
      {theme.logoUrl && <img className="store-logo" src={theme.logoUrl} alt={`${data.storefront.vendor_name} logo`} />}
      <div><p className="eyebrow">Vendor storefront</p><h1>{data.storefront.vendor_name}</h1></div>
    </header>
    <section className="storefulfillment-location">
      <div className="field"><label htmlFor="store-fulfillment">Fulfillment</label><select id="store-fulfillment" value={fulfillment} onChange={(event) => setFulfillment(event.target.value)}><option value="PICKUP">Pickup</option><option value="DELIVERY" disabled={!data.storefront.default_fulfillment_branch_id}>Delivery</option></select></div>
      {fulfillment === 'PICKUP'
        ? <div className="field"><label htmlFor="store-branch">Pickup location</label><select id="store-branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}>{data.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.display_name}</option>)}</select></div>
        : <p>Delivery inventory is checked at the vendor’s configured fulfillment location.</p>}
    </section>
    {data.categories?.length > 0 && <div className="store-category-filter"><label htmlFor="store-category-filter">Browse category</label><select id="store-category-filter" value={selectedCategoryId} onChange={(event) => setSelectedCategoryId(event.target.value)}><option value="">All products</option>{data.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div>}
    {payment && <section className="store-order-status" aria-live="polite"><h2>Order {payment.orderId}</h2><p>Status: {String(payment.status || 'PENDING_PAYMENT').replaceAll('_', ' ').toLowerCase()}</p>{payment.paymentAmount > 0 && <p>Payment amount: {money(payment.paymentAmount)}</p>}{payment.reference && <p>Payment reference: <span className="mono">{payment.reference}</span></p>}{payment.status === 'PENDING_PAYMENT' && <p>Do not submit another payment while this order is pending.</p>}{cardRedirectHtml && <><h3>Verify card payment</h3><iframe title="Card verification" sandbox="allow-forms allow-scripts allow-top-navigation-by-user-activation" srcDoc={cardRedirectHtml} style={{ width: '100%', minHeight: 500, border: 0 }} /></>}<Link to="/my-orders">Track your order</Link></section>}
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
        {allProducts.filter((product) => cart[product.id]).map((product) => <div className="store-cart-line" key={product.id}><label>{product.name} · {money(product.price)}</label><input aria-label={`Quantity for ${product.name}`} type="number" min="0" max="100" value={cart[product.id]} onChange={(e) => changeQty(product.id, e.target.value)} /></div>)}
        <div className="two-col">
          {fulfillment === 'DELIVERY' && <div className="field"><label>Delivery address</label><input required maxLength="1000" value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>}
          <div className="field"><label>Your mobile number</label><input required inputMode="tel" autoComplete="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="0551234567" /></div>
          <div className="field"><label>Name (optional)</label><input maxLength="160" value={customerName} onChange={(e) => setCustomerName(e.target.value)} /></div>
        </div>
        {data.creditDefaults?.enabled && <div className="field"><label>Payment method</label><select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}><option value="EGANOW">Pay now with Eganow</option><option value="CREDIT">Hire-purchase ({data.creditDefaults.installment_count} {String(data.creditDefaults.installment_frequency).toLowerCase()} installments; {data.creditDefaults.down_payment_percent}% down payment)</option></select></div>}
        {(paymentMethod === 'EGANOW' || Number(data.creditDefaults?.down_payment_percent) > 0) && <div className="field"><label>Collection method</label><select value={collectionMethod} onChange={(e) => { setCollectionMethod(e.target.value); setNetworkProvider('') }}><option value="MOMO">MoMo</option><option value="CARD">Card (Visa / Mastercard)</option></select></div>}
        {collectionMethod === 'MOMO' && (paymentMethod === 'EGANOW' || Number(data.creditDefaults?.down_payment_percent) > 0) && <div className="field"><label>MoMo channel</label><select value={networkProvider} onChange={(e) => setNetworkProvider(e.target.value)}><option value="">Auto-detect from phone number</option>{MOMO_CHANNELS.map((channel) => <option key={channel.code} value={channel.code}>{channel.label}</option>)}</select></div>}
        {collectionMethod === 'CARD' && (paymentMethod === 'EGANOW' || Number(data.creditDefaults?.down_payment_percent) > 0) && <div className="two-col"><div className="field"><label>Card number</label><input required autoComplete="cc-number" inputMode="numeric" value={card.number} onChange={(e) => setCard((v) => ({ ...v, number: e.target.value }))} /></div><div className="field"><label>Cardholder name</label><input required autoComplete="cc-name" value={card.name} onChange={(e) => setCard((v) => ({ ...v, name: e.target.value }))} /></div><div className="field"><label>Expiry month</label><input required type="number" min="1" max="12" autoComplete="cc-exp-month" value={card.month} onChange={(e) => setCard((v) => ({ ...v, month: e.target.value }))} /></div><div className="field"><label>Expiry year</label><input required inputMode="numeric" autoComplete="cc-exp-year" placeholder="2030" value={card.year} onChange={(e) => setCard((v) => ({ ...v, year: e.target.value }))} /></div><div className="field"><label>CVV</label><input required type="password" inputMode="numeric" autoComplete="cc-csc" value={card.cvv} onChange={(e) => setCard((v) => ({ ...v, cvv: e.target.value }))} /></div></div>}
        {error && <div className="status-banner error" role="alert">{error}</div>}{notice && <div className="status-banner success" role="status">{notice}</div>}
        <button className="btn btn-primary" disabled={submitting || payment?.status === 'PENDING_PAYMENT' || !branchId && fulfillment === 'PICKUP'}>{submitting ? 'Starting checkout…' : payment?.status === 'PENDING_PAYMENT' ? 'Payment pending' : `Place order · ${money(total)}`}</button>
      </form>
    </aside>}
  </main>
}
