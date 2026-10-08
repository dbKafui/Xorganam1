import { useEffect, useState } from 'react'
import { platformSecurityApi } from '../api/auth'

const EMPTY_FILTERS = { tenantId: '', actorUserId: '', actorInstitutionStaffId: '', action: '', resourceType: '', resourceId: '', fromDate: '', toDate: '' }

export default function AuditLog() {
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [appliedFilters, setAppliedFilters] = useState(EMPTY_FILTERS)
  const [page, setPage] = useState(1)
  const [result, setResult] = useState({ events: [], totalCount: 0, totalPages: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    platformSecurityApi.listAuditLog({ ...appliedFilters, page, pageSize: 50 })
      .then((data) => { if (active) setResult(data) })
      .catch((requestError) => { if (active) setError(requestError.message || 'Could not load activity history.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [appliedFilters, page])

  function submitFilters(event) {
    event.preventDefault()
    setPage(1)
    setAppliedFilters({ ...filters })
  }

  return <section>
    <header className="page-header">
      <div><div className="eyebrow">PLATFORM CONTROLS</div><h1>Activity audit log</h1><p>Append-only security and administration events across the platform.</p></div>
    </header>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    <form className="panel audit-filter-grid" onSubmit={submitFilters}>
      <div className="field"><label htmlFor="audit-tenant">Tenant ID</label><input id="audit-tenant" value={filters.tenantId} onChange={(event) => setFilters({ ...filters, tenantId: event.target.value })} /></div>
      <div className="field"><label htmlFor="audit-actor">Actor user ID</label><input id="audit-actor" value={filters.actorUserId} onChange={(event) => setFilters({ ...filters, actorUserId: event.target.value })} /></div>
      <div className="field"><label htmlFor="audit-institution-actor">Institution staff actor ID</label><input id="audit-institution-actor" value={filters.actorInstitutionStaffId} onChange={(event) => setFilters({ ...filters, actorInstitutionStaffId: event.target.value })} /></div>
      <div className="field"><label htmlFor="audit-action">Action</label><input id="audit-action" value={filters.action} onChange={(event) => setFilters({ ...filters, action: event.target.value })} /></div>
      <div className="field"><label htmlFor="audit-resource">Resource type</label><input id="audit-resource" value={filters.resourceType} onChange={(event) => setFilters({ ...filters, resourceType: event.target.value })} /></div>
      <div className="field"><label htmlFor="audit-resource-id">Resource ID</label><input id="audit-resource-id" value={filters.resourceId} onChange={(event) => setFilters({ ...filters, resourceId: event.target.value })} /></div>
      <div className="field"><label htmlFor="audit-from">From</label><input id="audit-from" type="date" value={filters.fromDate} onChange={(event) => setFilters({ ...filters, fromDate: event.target.value })} /></div>
      <div className="field"><label htmlFor="audit-to">To</label><input id="audit-to" type="date" value={filters.toDate} onChange={(event) => setFilters({ ...filters, toDate: event.target.value })} /></div>
      <button className="btn btn-primary" disabled={loading}>{loading ? 'Loading…' : 'Apply filters'}</button>
      <button className="btn btn-secondary" type="button" disabled={loading} onClick={() => { setFilters(EMPTY_FILTERS); setPage(1); setAppliedFilters(EMPTY_FILTERS) }}>Clear</button>
    </form>

    <div className="panel">
      <div className="section-heading"><h2>Events</h2><span>{result.totalCount} total</span></div>
      {loading ? <div className="empty-state" aria-live="polite">Loading audit history…</div> : result.events.length === 0 ? <div className="empty-state">No activity matches these filters.</div> : (
        <div className="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Tenant / merchant</th><th>Details</th></tr></thead><tbody>
          {result.events.map((event) => <tr key={event.id}>
            <td><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></td>
            <td>{event.actorEmail || event.actorUserId || event.actorInstitutionStaffId || 'System'}</td>
            <td className="mono">{event.action}</td>
            <td>{event.resourceType}{event.resourceId ? <small className="mono">{event.resourceId}</small> : null}</td>
            <td>{event.tenantName || event.tenantId || 'Platform'}{event.merchantName ? <small>{event.merchantName}</small> : null}</td>
            <td><details><summary>View</summary><pre className="audit-details">{JSON.stringify(event.details, null, 2)}</pre></details></td>
          </tr>)}
        </tbody></table></div>
      )}
      <div className="audit-pagination">
        <button className="btn btn-secondary" disabled={loading || page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button>
        <span aria-live="polite">Page {page} of {result.totalPages || 1}</span>
        <button className="btn btn-secondary" disabled={loading || page >= result.totalPages} onClick={() => setPage((current) => current + 1)}>Next</button>
      </div>
    </div>
  </section>
}