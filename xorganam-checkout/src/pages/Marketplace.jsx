import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { publicApi } from '../api/client'

const storefrontBase = import.meta.env.VITE_STOREFRONT_PUBLIC_URL || ''
function money(value) { return `GHS ${Number(value || 0).toFixed(2)}` }

export default function Marketplace() {
  const [categories, setCategories] = useState([])
  const [products, setProducts] = useState([])
  const [term, setTerm] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => { publicApi.getMarketplaceCategories().then(setCategories).catch((requestError) => setError(requestError.message)) }, [])
  useEffect(() => {
    let current = true
    setLoading(true); setError('')
    const load = categoryId
      ? publicApi.getMarketplaceCategoryProducts(categoryId)
      : publicApi.searchMarketplace({ q: term })
    load.then((rows) => { if (current) setProducts(rows || []) })
      .catch((requestError) => { if (current) setError(requestError.message) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [term, categoryId])

  return <main className="marketplace-shell">
    <nav className="store-topbar"><Link to="/">XORGANAM</Link><Link to="/my-orders">My orders & reviews</Link><Link to="/operator/login">Vendor login</Link></nav>
    <header className="marketplace-hero"><p className="eyebrow">XORGANAM Marketplace</p><h1>Discover local vendors</h1><p>Browse products and services from participating storefronts.</p></header>
    <section className="marketplace-controls"><div className="field"><label htmlFor="market-search">Search</label><input id="market-search" type="search" maxLength="120" placeholder="Search products and services" value={term} onChange={(event) => { setTerm(event.target.value); setCategoryId('') }} /></div>
      <div className="field"><label htmlFor="market-category">Category</label><select id="market-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">All categories</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name} ({category.listing_count})</option>)}</select></div>
    </section>
    {error && <div className="status-banner error" role="alert">{error}</div>}
    {loading ? <div className="empty-state">Loading listings…</div> : products.length ? <section className="marketplace-products">{products.map((product) => {
      const image = product.media?.[0]
      const storePath = `/store/${product.vendor_slug}?source=marketplace`
      const storeUrl = storefrontBase ? `${storefrontBase.replace(/\/$/, '')}${storePath}` : storePath
      return <article className="store-product-card" key={product.id}>
        {image ? <img src={image.url} alt={image.altText || product.name} loading="lazy" /> : <div className="store-product-placeholder">{product.listing_type === 'SERVICE' ? 'Service' : 'Product'}</div>}
        <div className="store-product-copy"><p className="eyebrow">{product.vendor_name}</p><h2>{product.name}</h2><p>{product.description}</p><strong>{money(product.price)}</strong>
          <a className="btn btn-primary" href={storeUrl}>Visit storefront</a>
        </div>
      </article>
    })}</section> : <div className="empty-state">No participating vendor listings matched this search.</div>}
  </main>
}
