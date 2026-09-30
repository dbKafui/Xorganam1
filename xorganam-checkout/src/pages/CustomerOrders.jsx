import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { creditCustomerApi, publicApi, storefrontCustomerApi } from '../api/client'

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '')
  if (digits.startsWith('0') && digits.length === 10) return `233${digits.slice(1)}`
  if (digits.startsWith('233') && digits.length === 12) return digits
  if (digits.length === 9) return `233${digits}`
  return ''
}
function money(value) { return `GHS ${Number(value || 0).toFixed(2)}` }

export default function CustomerOrders() {
  const [phone, setPhone] = useState(creditCustomerApi.getPhone())
  const [code, setCode] = useState('')
  const [requested, setRequested] = useState(false)
  const [orders, setOrders] = useState([])
  const [orderId, setOrderId] = useState('')
  const [targetType, setTargetType] = useState('PRODUCT')
  const [productId, setProductId] = useState('')
  const [rating, setRating] = useState('5')
  const [comment, setComment] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(creditCustomerApi.hasSession())

  async function loadOrders() {
    setLoading(true); setError('')
    try { setOrders(await storefrontCustomerApi.listOrders()) }
    catch (requestError) { creditCustomerApi.clearSession(); setError(requestError.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { if (creditCustomerApi.hasSession()) loadOrders() }, [])

  async function requestCode(event) {
    event.preventDefault(); setError('')
    const normalized = normalizePhone(phone)
    if (!normalized) return setError('Enter a valid Ghana mobile number.')
    try {
      await publicApi.requestCreditCustomerCode(normalized)
      setPhone(normalized); setRequested(true); setNotice('If an order or credit schedule matches this number, a code has been sent.')
    } catch (requestError) { setError(requestError.message) }
  }
  async function verify(event) {
    event.preventDefault(); setError('')
    try { creditCustomerApi.saveSession(await publicApi.verifyCreditCustomerCode(phone, code)); setNotice('Phone verified.'); await loadOrders() }
    catch (requestError) { setError(requestError.message) }
  }
  async function submitReview(event) {
    event.preventDefault(); setError(''); setNotice('')
    const order = orders.find((item) => item.id === orderId)
    if (!order) return setError('Choose an order.')
    try {
      await storefrontCustomerApi.submitReview({ targetType, productId: targetType === 'PRODUCT' ? productId : undefined,
        tenantId: targetType === 'VENDOR' ? order.tenant_id : undefined, orderId, rating: Number(rating), comment })
      setNotice('Review submitted for moderation.'); setComment(''); setProductId('')
    } catch (requestError) { setError(requestError.message) }
  }

  function signOut() { creditCustomerApi.clearSession(); setOrders([]); setRequested(false); setCode(''); setNotice('') }
  const reviewable = orders.filter((order) => ['PLACED', 'FULFILLED'].includes(order.status))
  const chosenOrder = orders.find((order) => order.id === orderId)

  return <main className="customer-orders-shell"><nav className="store-topbar"><Link to="/marketplace">Marketplace</Link><Link to="/">Checkout</Link></nav>
    <header className="marketplace-hero"><p className="eyebrow">Customer account</p><h1>My orders & reviews</h1><p>Verify the mobile number used at checkout to view orders and submit verified-purchase reviews.</p></header>
    {error && <div className="status-banner error" role="alert">{error}</div>}{notice && <div className="status-banner success" role="status">{notice}</div>}
    {!creditCustomerApi.hasSession() && !requested && <form className="card customer-verify" onSubmit={requestCode}><div className="field"><label>Mobile number used at checkout</label><input required inputMode="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="0551234567" /></div><button className="btn btn-primary">Send verification code</button></form>}
    {!creditCustomerApi.hasSession() && requested && <form className="card customer-verify" onSubmit={verify}><p>Enter the six-digit code sent to {phone}.</p><div className="field"><label>Verification code</label><input required inputMode="numeric" pattern="[0-9]{6}" maxLength="6" value={code} onChange={(event) => setCode(event.target.value)} /></div><button className="btn btn-primary">Verify phone</button></form>}
    {creditCustomerApi.hasSession() && <><div className="portal-header"><h2>Your orders</h2><button className="btn btn-secondary" onClick={signOut}>Sign out</button></div>
      {loading ? <div className="empty-state">Loading orders…</div> : orders.length ? <section className="card">{orders.map((order) => <article className="customer-order" key={order.id}>
        <div><strong>{order.vendor_name} · {money(order.total_amount)}</strong><small>Order {order.id} · {new Date(order.created_at).toLocaleString()} · {order.fulfillment_type.toLowerCase()} at {order.branch_name}</small>
          <div>{order.items.map((item) => <span className="order-item-tag" key={item.productId}>{item.name} × {item.quantity}</span>)}</div>
        </div><span className={`status-pill ${order.status.toLowerCase()}`}>{order.status.toLowerCase().replaceAll('_', ' ')}</span>
      </article>)}</section> : <div className="empty-state">No orders match this verified number.</div>}
      {reviewable.length > 0 && <form className="card" onSubmit={submitReview}><h2>Leave a verified-purchase review</h2><div className="two-col">
        <div className="field"><label>Order</label><select required value={orderId} onChange={(event) => { setOrderId(event.target.value); setProductId('') }}><option value="">Choose a placed or fulfilled order</option>{reviewable.map((order) => <option key={order.id} value={order.id}>{order.vendor_name} · {new Date(order.created_at).toLocaleDateString()}</option>)}</select></div>
        <div className="field"><label>Review target</label><select value={targetType} onChange={(event) => setTargetType(event.target.value)}><option value="PRODUCT">Product</option><option value="VENDOR">Vendor</option></select></div>
        {targetType === 'PRODUCT' && <div className="field"><label>Purchased product</label><select required value={productId} onChange={(event) => setProductId(event.target.value)}><option value="">Choose a product</option>{(chosenOrder?.items || []).map((item) => <option key={item.productId} value={item.productId}>{item.name}</option>)}</select></div>}
        <div className="field"><label>Rating</label><select value={rating} onChange={(event) => setRating(event.target.value)}><option value="5">5 stars</option><option value="4">4 stars</option><option value="3">3 stars</option><option value="2">2 stars</option><option value="1">1 star</option></select></div>
      </div><div className="field"><label>Comment (optional)</label><textarea maxLength="2000" value={comment} onChange={(event) => setComment(event.target.value)} /></div><button className="btn btn-primary">Submit for moderation</button></form>}
    </>}
  </main>
}
