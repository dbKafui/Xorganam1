import { useCallback, useEffect, useState } from 'react'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi, publicApi } from '../../api/client'

const blankProduct = { name: '', description: '', listingType: 'PHYSICAL', price: '', categoryId: '', imageUrl: '' }
const blankDefaults = { enabled: false, downPaymentPercent: '0', installmentCount: '4', installmentFrequency: 'MONTHLY', markupAmount: '0', lateFeeAmount: '0', lateFeeGraceDays: '0', missedInstallmentThreshold: '3', firstDueDays: '30' }
const storefrontBase = import.meta.env.VITE_STOREFRONT_PUBLIC_URL || ''

function money(value) { return `GHS ${Number(value || 0).toFixed(2)}` }

export default function OperatorStorefront() {
  const { user } = useOperatorAuth()
  const isManager = ['TENANT_ADMIN', 'TENANT_MANAGER', 'PLATFORM_ADMIN'].includes(user?.role)
  const [store, setStore] = useState(null)
  const [products, setProducts] = useState([])
  const [branches, setBranches] = useState([])
  const [categories, setCategories] = useState([])
  const [orders, setOrders] = useState([])
  const [defaults, setDefaults] = useState(blankDefaults)
  const [slug, setSlug] = useState('')
  const [optIn, setOptIn] = useState(false)
  const [defaultBranch, setDefaultBranch] = useState('')
  const [brandingText, setBrandingText] = useState('{"theme":{"primaryColor":"#1a2b3c","font":"Inter"},"blocks":[]}')
  const [productForm, setProductForm] = useState(blankProduct)
  const [selectedBranch, setSelectedBranch] = useState(user?.merchantId || '')
  const [stockForm, setStockForm] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    if (!user?.tenantId) return
    const [productRows, orderRows, merchantRows, categoryRows, defaultRows] = await Promise.all([
      operatorApi.listStorefrontProducts(user.tenantId),
      operatorApi.getStorefrontOrders({ tenantId: user.tenantId, ...(user.merchantId ? { merchantId: user.merchantId } : {}) }),
      operatorApi.listMerchants(user.tenantId),
      publicApi.getMarketplaceCategories(),
      isManager ? operatorApi.getCreditDefaults(user.tenantId) : Promise.resolve(null)
    ])
    setProducts(productRows || [])
    setOrders(orderRows || [])
    const availableBranches = (merchantRows || []).filter((row) => row.isActive && row.accountSetupStatus === 'ACTIVE')
    setBranches(availableBranches)
    if (!selectedBranch && (user.merchantId || availableBranches[0]?.id)) setSelectedBranch(user.merchantId || availableBranches[0].id)
    setCategories(categoryRows || [])
    if (defaultRows) setDefaults({ ...blankDefaults, ...defaultRows, downPaymentPercent: String(defaultRows.down_payment_percent ?? 0), installmentCount: String(defaultRows.installment_count ?? 4), installmentFrequency: defaultRows.installment_frequency || 'MONTHLY', markupAmount: String(defaultRows.markup_amount ?? 0), lateFeeAmount: String(defaultRows.late_fee_amount ?? 0), lateFeeGraceDays: String(defaultRows.late_fee_grace_days ?? 0), missedInstallmentThreshold: String(defaultRows.missed_installment_threshold ?? 3), firstDueDays: String(defaultRows.first_due_days ?? 30) })
    const storefront = await operatorApi.getStorefront(user.tenantId).catch((requestError) => requestError.status === 404 ? null : Promise.reject(requestError))
    setStore(storefront)
    if (storefront) {
      setSlug(storefront.slug)
      setOptIn(storefront.marketplace_opt_in)
      setDefaultBranch(storefront.default_fulfillment_branch_id || '')
      setBrandingText(JSON.stringify(storefront.branding_config || {}, null, 2))
    }
  }, [user?.tenantId, user?.merchantId, isManager, selectedBranch])

  useEffect(() => { refresh().catch((requestError) => setError(requestError.message)) }, [refresh])

  async function saveStore(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      const brandingConfig = JSON.parse(brandingText)
      const result = await operatorApi.saveStorefront({ tenantId: user.tenantId, slug, marketplaceOptIn: optIn, defaultFulfillmentBranchId: defaultBranch || null, brandingConfig })
      setStore(result); setNotice('Storefront settings saved.')
    } catch (requestError) { setError(requestError instanceof SyntaxError ? 'Branding must be valid JSON.' : requestError.message) }
    finally { setBusy(false) }
  }

  async function createProduct(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      const media = productForm.imageUrl.trim() ? [{ url: productForm.imageUrl.trim(), altText: productForm.name }] : []
      await operatorApi.createStorefrontProduct({ tenantId: user.tenantId, name: productForm.name, description: productForm.description,
        listingType: productForm.listingType, price: Number(productForm.price), categoryId: productForm.categoryId || null, media })
      setProductForm(blankProduct); setNotice('Product created. Set its stock by branch below.'); await refresh()
    } catch (requestError) { setError(requestError.message) }
    finally { setBusy(false) }
  }

  async function saveStock(product) {
    const value = stockForm[product.id] || {}
    setBusy(true); setError(''); setNotice('')
    try {
      await operatorApi.updateStorefrontStock(product.id, { tenantId: user.tenantId, merchantId: selectedBranch, quantityAvailable: Number(value.quantity ?? 0), unlimitedStock: Boolean(value.unlimited) })
      setNotice(`Inventory updated for ${product.name}.`); await refresh()
    } catch (requestError) { setError(requestError.message) }
    finally { setBusy(false) }
  }

  async function setVisibility(product) {
    setBusy(true); setError('')
    try { await operatorApi.updateStorefrontProductVisibility(product.id, !product.visible); await refresh() }
    catch (requestError) { setError(requestError.message) }
    finally { setBusy(false) }
  }

  async function updateOrder(order, status) {
    if (status === 'CANCELLED' && !window.confirm('Cancel this order and release its reserved stock? A payment already collected is not automatically refunded.')) return
    setBusy(true); setError(''); setNotice('')
    try { await operatorApi.updateStorefrontOrderStatus(order.id, status, status === 'CANCELLED' ? 'Cancelled by vendor.' : undefined); setNotice(`Order marked ${status.toLowerCase()}.`); await refresh() }
    catch (requestError) { setError(requestError.message) }
    finally { setBusy(false) }
  }

  async function saveDefaults(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      await operatorApi.saveCreditDefaults({ tenantId: user.tenantId, enabled: defaults.enabled,
        downPaymentPercent: Number(defaults.downPaymentPercent), installmentCount: Number(defaults.installmentCount), installmentFrequency: defaults.installmentFrequency,
        markupAmount: Number(defaults.markupAmount), lateFeeAmount: Number(defaults.lateFeeAmount), lateFeeGraceDays: Number(defaults.lateFeeGraceDays),
        missedInstallmentThreshold: Number(defaults.missedInstallmentThreshold), firstDueDays: Number(defaults.firstDueDays) })
      setNotice('Credit checkout defaults saved.')
    } catch (requestError) { setError(requestError.message) }
    finally { setBusy(false) }
  }

  const shareUrl = store && storefrontBase ? `${storefrontBase.replace(/\/$/, '')}/store/${store.slug}` : ''
  return <div className="store-admin">
    <header className="portal-header"><div><h1>Storefront & marketplace</h1><p>Manage the vendor catalog, branch stock, online orders, storefront branding and credit checkout defaults.</p></div></header>
    {error && <div className="status-banner error" role="alert">{error}</div>}{notice && <div className="status-banner success" role="status">{notice}</div>}
    <section className="card"><h2>Storefront</h2>
      {isManager ? <form onSubmit={saveStore}><div className="two-col">
        <div className="field"><label>Storefront slug</label><input required minLength="3" maxLength="60" pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="my-shop" /></div>
        <div className="field"><label>Delivery fulfillment branch</label><select value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)}><option value="">Not configured</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.displayName}</option>)}</select></div>
      </div><label className="checkbox-row"><input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} /> List visible products in the cross-vendor marketplace</label>
      <div className="field"><label>Freeform branding document (JSON)</label><textarea rows="10" value={brandingText} onChange={(e) => setBrandingText(e.target.value)} spellCheck="false" /><small>Blocks: hero, product_grid and rich_text. HTML, image URLs, fonts and colors are validated on save.</small></div>
      <button className="btn btn-primary" disabled={busy}>{store ? 'Save storefront settings' : 'Create storefront'}</button>
      {shareUrl ? <p className="link-row"><a href={shareUrl} target="_blank" rel="noreferrer">Open public storefront</a> · {shareUrl}</p> : <p className="subtle">Set VITE_STOREFRONT_PUBLIC_URL to the separate public-storefront origin before sharing links.</p>}
      </form> : <p>Storefront settings are managed by tenant administrators. Branch managers can update branch inventory and fulfill orders below.</p>}
    </section>

    {isManager && <section className="card"><h2>Credit checkout defaults</h2><p className="subtle">Customers can use these standing terms at checkout. The first installment is due this many days after purchase.</p>
      <form onSubmit={saveDefaults}><label className="checkbox-row"><input type="checkbox" checked={Boolean(defaults.enabled)} onChange={(e) => setDefaults({ ...defaults, enabled: e.target.checked })} /> Offer hire-purchase checkout</label>
      <div className="two-col">
        <div className="field"><label>Down payment (%)</label><input type="number" min="0" max="99.99" step="0.01" value={defaults.downPaymentPercent} onChange={(e) => setDefaults({ ...defaults, downPaymentPercent: e.target.value })} /></div>
        <div className="field"><label>Installments</label><input type="number" min="1" max="120" value={defaults.installmentCount} onChange={(e) => setDefaults({ ...defaults, installmentCount: e.target.value })} /></div>
        <div className="field"><label>Frequency</label><select value={defaults.installmentFrequency} onChange={(e) => setDefaults({ ...defaults, installmentFrequency: e.target.value })}><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></select></div>
        <div className="field"><label>First installment due in (days)</label><input type="number" min="1" max="365" value={defaults.firstDueDays} onChange={(e) => setDefaults({ ...defaults, firstDueDays: e.target.value })} /></div>
        <div className="field"><label>Markup (GHS)</label><input type="number" min="0" step="0.01" value={defaults.markupAmount} onChange={(e) => setDefaults({ ...defaults, markupAmount: e.target.value })} /></div>
        <div className="field"><label>Late fee per overdue installment (GHS)</label><input type="number" min="0" step="0.01" value={defaults.lateFeeAmount} onChange={(e) => setDefaults({ ...defaults, lateFeeAmount: e.target.value })} /></div>
        <div className="field"><label>Late fee grace days</label><input type="number" min="0" max="365" value={defaults.lateFeeGraceDays} onChange={(e) => setDefaults({ ...defaults, lateFeeGraceDays: e.target.value })} /></div>
        <div className="field"><label>Missed installment threshold</label><input type="number" min="1" max="120" value={defaults.missedInstallmentThreshold} onChange={(e) => setDefaults({ ...defaults, missedInstallmentThreshold: e.target.value })} /></div>
      </div><button className="btn btn-primary" disabled={busy}>Save credit defaults</button></form>
    </section>}

    {isManager && <section className="card"><h2>Add a product</h2><form onSubmit={createProduct}><div className="two-col">
      <div className="field"><label>Name</label><input required maxLength="160" value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} /></div>
      <div className="field"><label>Price (GHS)</label><input required type="number" min="0.01" step="0.01" value={productForm.price} onChange={(e) => setProductForm({ ...productForm, price: e.target.value })} /></div>
      <div className="field"><label>Listing type</label><select value={productForm.listingType} onChange={(e) => setProductForm({ ...productForm, listingType: e.target.value })}><option value="PHYSICAL">Physical product</option><option value="SERVICE">Service</option></select></div>
      <div className="field"><label>Marketplace category</label><select value={productForm.categoryId} onChange={(e) => setProductForm({ ...productForm, categoryId: e.target.value })}><option value="">Storefront only</option>{categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></div>
      <div className="field"><label>HTTPS image URL (optional)</label><input type="url" value={productForm.imageUrl} onChange={(e) => setProductForm({ ...productForm, imageUrl: e.target.value })} /></div>
      <div className="field"><label>Description</label><textarea rows="3" value={productForm.description} onChange={(e) => setProductForm({ ...productForm, description: e.target.value })} /></div>
    </div><button className="btn btn-primary" disabled={busy}>Add product</button></form></section>}

    <section className="card"><h2>Product catalog & branch stock</h2>
      <div className="field"><label>Branch for stock management</label><select value={selectedBranch} onChange={(e) => setSelectedBranch(e.target.value)}>{branches.map((branch) => <option value={branch.id} key={branch.id}>{branch.displayName}</option>)}</select></div>
      {!products.length ? <div className="empty-state">No products yet.</div> : products.map((product) => {
        const current = product.stock_by_branch?.find((item) => item.merchantId === selectedBranch)
        const form = stockForm[product.id] || { quantity: current?.quantityAvailable ?? 0, unlimited: current?.unlimitedStock ?? false }
        return <div className="credit-plan-row" key={product.id}>
          <span><strong>{product.name}</strong><small>{money(product.price)} · {product.listing_type.toLowerCase()} · {product.visible ? 'visible' : 'hidden'}</small></span>
          <span className="store-stock-actions"><input aria-label={`Quantity for ${product.name}`} type="number" min="0" max="1000000" value={form.quantity ?? 0} disabled={form.unlimited || busy} onChange={(e) => setStockForm({ ...stockForm, [product.id]: { ...form, quantity: e.target.value } })} />
            {product.listing_type === 'SERVICE' && <label><input type="checkbox" checked={Boolean(form.unlimited)} onChange={(e) => setStockForm({ ...stockForm, [product.id]: { ...form, unlimited: e.target.checked } })} /> Unlimited</label>}
            <button className="btn btn-secondary btn-sm" disabled={!selectedBranch || busy} onClick={() => saveStock(product)}>Save stock</button>
            {isManager && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setVisibility(product)}>{product.visible ? 'Hide' : 'Show'}</button>}
          </span>
        </div>
      })}
    </section>

    <section className="card"><h2>Orders</h2>{!orders.length ? <div className="empty-state">No orders have been placed.</div> : orders.map((order) => <div className="credit-plan-row" key={order.id}>
      <span><strong>{order.customer_name || order.customer_identifier} · {money(order.total_amount)}</strong><small>{order.branch_name} · {order.fulfillment_type.toLowerCase()} · {new Date(order.created_at).toLocaleString()} · {order.items.map((item) => `${item.name} × ${item.quantity}`).join(', ')}</small></span>
      <span className={`status-pill ${order.status.toLowerCase()}`}>{order.status.toLowerCase().replaceAll('_', ' ')}
        {order.status === 'PLACED' && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => updateOrder(order, 'FULFILLED')}>Mark fulfilled</button>}
        {['PLACED', 'PENDING_PAYMENT'].includes(order.status) && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => updateOrder(order, 'CANCELLED')}>Cancel</button>}
      </span>
    </div>)}</section>
    {isManager && <p className="link-row">Customer reviews appear publicly only after platform-admin moderation. Payment successes after an order cancellation are queued for manual Backoffice reconciliation.</p>}
  </div>
}
