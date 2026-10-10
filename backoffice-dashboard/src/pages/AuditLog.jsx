import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { platformSecurityApi } from '../api/auth'

const EMPTY_FILTERS = { tenantId: '', actorUserId: '', actorInstitutionStaffId: '', action: '', resourceType: '', resourceId: '', fromDate: '', toDate: '' }

function csvCell(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}

export default function AuditLog() {
  const [searchParams] = useSearchParams()
  const initialFilters = { ...EMPTY_FILTERS, actorUserId: searchParams.get('actorUserId') || '' }
  const [filters, setFilters] = useState(initialFilters)
  const [appliedFilters, setAppliedFilters] = useState(initialFilters)
  const [page, setPage] = useState(1)
  const [result, setResult] = useState({ events: [], totalCount: 0, totalPages: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const activeFilterCount = Object.values(appliedFilters).filter((value) => String(value).trim() !== '').length

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

  function exportVisiblePage() {
    const columns = ['createdAt', 'actorEmail', 'actorUserId', 'actorInstitutionStaffId', 'tenantId', 'tenantName', 'merchantId', 'merchantName', 'action', 'resourceType', 'resourceId', 'ipAddress', 'userAgent', 'requestId', 'details']
    const csv = [columns, ...result.events.map((event) => columns.map((column) => event[column]))]
      .map((row) => row.map(csvCell).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `audit-events-page-${page}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return <section className="audit-log-page">
    <header className="page-header audit-header">
      <div>
        <div className="eyebrow">PLATFORM CONTROLS</div>
        <h1>Activity audit log</h1>
        <p>Append-only security and administration events across the platform.</p>
      </div>
      <button className="btn btn-secondary" type="button" disabled={loading || result.events.length === 0} onClick={exportVisiblePage}>Export page</button>
    </header>

    <div className="audit-summary-row">
      <div className="audit-summary-box audit-summary-box-primary">
        <span>Total events</span>
        <strong>{result.totalCount}</strong>
      </div>
      <div className="audit-summary-box">
        <span>On page</span>
        <strong>{result.events.length}</strong>
      </div>
      <div className="audit-summary-box">
        <span>Active filters</span>
        <strong>{activeFilterCount}</strong>
      </div>
    </div>

    {error && <div className="alert alert-error" role="alert">{error}</div>}

    <div className="panel audit-filter-panel">
      <div className="audit-filter-header">
        <h2>Filter events</h2>
        <div className="panel-badge">{result.totalPages ? `Page ${page} / ${result.totalPages}` : 'No pages'}</div>
      </div>
      <form className="audit-filter-grid" onSubmit={submitFilters}>
        <div className="field"><label htmlFor="audit-tenant">Tenant ID</label><input id="audit-tenant" value={filters.tenantId} onChange={(event) => setFilters({ ...filters, tenantId: event.target.value })} /></div>
        <div className="field"><label htmlFor="audit-actor">Actor user ID</label><input id="audit-actor" value={filters.actorUserId} onChange={(event) => setFilters({ ...filters, actorUserId: event.target.value })} /></div>
        <div className="field"><label htmlFor="audit-institution-actor">Institution staff actor ID</label><input id="audit-institution-actor" value={filters.actorInstitutionStaffId} onChange={(event) => setFilters({ ...filters, actorInstitutionStaffId: event.target.value })} /></div>
        <div className="field"><label htmlFor="audit-action">Action</label><input id="audit-action" value={filters.action} onChange={(event) => setFilters({ ...filters, action: event.target.value })} /></div>
        <div className="field"><label htmlFor="audit-resource">Resource type</label><input id="audit-resource" value={filters.resourceType} onChange={(event) => setFilters({ ...filters, resourceType: event.target.value })} /></div>
        <div className="field"><label htmlFor="audit-resource-id">Resource ID</label><input id="audit-resource-id" value={filters.resourceId} onChange={(event) => setFilters({ ...filters, resourceId: event.target.value })} /></div>
        <div className="field"><label htmlFor="audit-from">From</label><input id="audit-from" type="date" value={filters.fromDate} onChange={(event) => setFilters({ ...filters, fromDate: event.target.value })} /></div>
        <div className="field"><label htmlFor="audit-to">To</label><input id="audit-to" type="date" value={filters.toDate} onChange={(event) => setFilters({ ...filters, toDate: event.target.value })} /></div>
        <div className="audit-filter-actions">
          <button className="btn btn-primary" disabled={loading}>{loading ? 'Loading…' : 'Apply filters'}</button>
          <button className="btn btn-secondary" type="button" disabled={loading} onClick={() => { setFilters(EMPTY_FILTERS); setPage(1); setAppliedFilters(EMPTY_FILTERS) }}>Clear</button>
        </div>
      </form>
    </div>

    <div className="panel audit-log-panel">
      <div className="section-heading">
        <div>
          <h2>Recent events</h2>
          <span className="section-meta">{result.totalCount} total</span>
        </div>
        <button className="btn btn-secondary" type="button" disabled={loading || result.events.length === 0} onClick={exportVisiblePage}>Export visible page as CSV</button>
      </div>

      {loading ? <div className="empty-state" aria-live="polite">Loading audit history…</div> : result.events.length === 0 ? <div className="empty-state">No activity matches these filters.</div> : (
        <div className="table-wrap audit-log-table-wrap"><table className="audit-log-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Tenant / merchant</th><th>Details</th></tr></thead><tbody>
          {result.events.map((event) => <tr key={event.id}>
            <td className="event-time"><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></td>
            <td className="event-actor">{event.actorEmail || event.actorUserId || event.actorInstitutionStaffId || 'System'}</td>
            <td className="event-action mono">{event.action}</td>
            <td className="event-target">{event.resourceType}{event.resourceId ? <small className="mono">{event.resourceId}</small> : null}</td>
            <td className="event-tenant">{event.tenantName || event.tenantId || 'Platform'}{event.merchantName ? <small>{event.merchantName}</small> : null}</td>
            <td className="event-details-cell"><details><summary>View</summary><pre className="audit-details">{JSON.stringify(event.details, null, 2)}</pre></details></td>
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
