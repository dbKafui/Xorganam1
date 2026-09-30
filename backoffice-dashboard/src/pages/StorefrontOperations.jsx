import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'

export default function StorefrontOperations() {
  const [reviews, setReviews] = useState([])
  const [flags, setFlags] = useState([])
  const [categories, setCategories] = useState([])
  const [categoryName, setCategoryName] = useState('')
  const [categorySlug, setCategorySlug] = useState('')
  const [notes, setNotes] = useState({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    const [pending, openFlags, categoryRows] = await Promise.all([
      api.get('/storefront-admin/reviews/moderation', { status: 'PENDING_MODERATION' }),
      api.get('/storefront-admin/reconciliation-flags'),
      api.get('/storefront-admin/categories')
    ])
    setReviews(pending || []); setFlags(openFlags || []); setCategories(categoryRows || [])
  }, [])
  useEffect(() => { load().catch((requestError) => setError(requestError.message)) }, [load])

  async function moderate(reviewId, status) {
    setBusy(reviewId); setError(''); setNotice('')
    try { await api.patch(`/storefront-admin/reviews/${reviewId}/moderation`, { status }); setNotice(`Review ${status.toLowerCase()}.`); await load() }
    catch (requestError) { setError(requestError.message) }
    finally { setBusy('') }
  }
  async function resolve(flagId) {
    const resolutionNote = String(notes[flagId] || '').trim()
    if (!resolutionNote) return setError('Add a resolution note before closing a payment flag.')
    setBusy(flagId); setError(''); setNotice('')
    try { await api.patch(`/storefront-admin/reconciliation-flags/${flagId}/resolve`, { resolutionNote }); setNotice('Payment flag marked resolved.'); await load() }
    catch (requestError) { setError(requestError.message) }
    finally { setBusy('') }
  }
  async function addCategory(event) {
    event.preventDefault(); setBusy('category'); setError(''); setNotice('')
    try {
      await api.post('/storefront-admin/categories', { name: categoryName, slug: categorySlug })
      setCategoryName(''); setCategorySlug(''); setNotice('Marketplace category created.'); await load()
    } catch (requestError) { setError(requestError.message) }
    finally { setBusy('') }
  }
  async function removeCategory(category) {
    if (!window.confirm(`Delete category “${category.name}”? Products using it will become uncategorized.`)) return
    setBusy(category.id); setError(''); setNotice('')
    try { await api.del(`/storefront-admin/categories/${category.id}`); setNotice('Category deleted.'); await load() }
    catch (requestError) { setError(requestError.message) }
    finally { setBusy('') }
  }

  return <div>
    <header className="page-header"><div><h1>Storefront operations</h1><p>Platform-admin review moderation and late-payment reconciliation.</p></div></header>
    {error && <div className="alert alert-error">{error}</div>}{notice && <div className="alert alert-success">{notice}</div>}
    <section className="panel"><h2>Marketplace categories</h2><form className="form-grid" onSubmit={addCategory}>
      <label>Name<input required maxLength="80" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} /></label>
      <label>Slug<input required pattern="[a-z0-9]+(-[a-z0-9]+)*" value={categorySlug} onChange={(event) => setCategorySlug(event.target.value.toLowerCase())} placeholder="home-goods" /></label>
      <button className="btn btn-primary" disabled={!!busy}>Add category</button>
    </form><div className="table-wrap"><table><thead><tr><th>Category</th><th>Slug</th><th>Marketplace listings</th><th></th></tr></thead><tbody>
      {categories.map((category) => <tr key={category.id}><td>{category.name}</td><td className="mono">{category.slug}</td><td>{category.listing_count ?? '—'}</td><td><button className="btn btn-secondary" disabled={!!busy} onClick={() => removeCategory(category)}>Delete</button></td></tr>)}
    </tbody></table></div></section>
    <section className="panel"><h2>Reviews pending moderation</h2>{reviews.length ? <div className="table-wrap"><table><thead><tr><th>Vendor / product</th><th>Review</th><th>Purchase</th><th>Submitted</th><th>Action</th></tr></thead><tbody>
      {reviews.map((review) => <tr key={review.id}><td>{review.vendor_name}<small>{review.target_type === 'PRODUCT' ? review.product_name : 'Vendor review'}</small></td>
        <td><strong>{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</strong><small>{review.comment || 'No comment'}</small></td>
        <td className="mono">{review.order_id}</td><td>{new Date(review.created_at).toLocaleString()}</td>
        <td><button className="btn btn-primary" disabled={!!busy} onClick={() => moderate(review.id, 'VISIBLE')}>Approve</button> <button className="btn btn-secondary" disabled={!!busy} onClick={() => moderate(review.id, 'HIDDEN')}>Hide</button></td>
      </tr>)}
    </tbody></table></div> : <p className="empty-state">No reviews are awaiting moderation.</p>}</section>
    <section className="panel"><h2>Order payments requiring reconciliation</h2><p>These payments succeeded after the related order reservation was cancelled. Resolve manually and record the chosen refund or fulfillment action.</p>
      {flags.length ? <div className="table-wrap"><table><thead><tr><th>Vendor / branch</th><th>Payment</th><th>Order / customer</th><th>Flagged</th><th>Resolution note</th><th></th></tr></thead><tbody>
        {flags.map((flag) => <tr key={flag.id}><td>{flag.vendor_name}<small>{flag.branch_name}</small></td>
          <td>{flag.payment_amount}<small className="mono">{flag.internal_reference}<br />{flag.eganow_reference}</small></td>
          <td className="mono">{flag.order_id}<small>{flag.customer_identifier}</small></td><td>{new Date(flag.created_at).toLocaleString()}<small>{flag.reason}</small></td>
          <td><textarea rows="2" value={notes[flag.id] || ''} onChange={(event) => setNotes({ ...notes, [flag.id]: event.target.value })} placeholder="Record refund or fulfillment action" /></td>
          <td><button className="btn btn-primary" disabled={!!busy} onClick={() => resolve(flag.id)}>Resolve</button></td>
        </tr>)}
      </tbody></table></div> : <p className="empty-state">No unresolved order payment flags.</p>}
    </section>
  </div>
}
