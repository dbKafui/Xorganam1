import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { reportsApi } from '../api/reports'
import { api } from '../api/client'

function money(n) {
  return Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function Overview() {
  const { user } = useAuth()
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [backendHealth, setBackendHealth] = useState('checking')
  const [operationalFailures, setOperationalFailures] = useState([])
  const [failureNotes, setFailureNotes] = useState({})
  const [resolvingFailureId, setResolvingFailureId] = useState('')
  const [failureError, setFailureError] = useState('')

  useEffect(() => {
    Promise.all([reportsApi.system(), api.listOperationalFailures({ status: 'OPEN', limit: 50 })])
      .then(([systemReport, failureList]) => {
        setReport(systemReport)
        setOperationalFailures(failureList || [])
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  async function resolveFailure(failure) {
    const note = String(failureNotes[failure.id] || '').trim()
    if (note.length < 5) {
      setFailureError('Add a resolution note of at least five characters.')
      return
    }
    setResolvingFailureId(failure.id)
    setFailureError('')
    try {
      await api.resolveOperationalFailure(failure.id, note)
      setOperationalFailures((current) => current.filter((item) => item.id !== failure.id))
      setFailureNotes((current) => { const next = { ...current }; delete next[failure.id]; return next })
    } catch (requestError) {
      setFailureError(requestError.message)
    } finally {
      setResolvingFailureId('')
    }
  }

  useEffect(() => {
    let active = true
    const check = () => api.health()
      .then(() => { if (active) setBackendHealth('online') })
      .catch(() => { if (active) setBackendHealth('offline') })
    check()
    const timer = window.setInterval(check, 30000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Overview</h1>
          <p>Welcome back, {user?.firstName}.</p>
        </div>
        <Link to="/tenants" className="btn btn-primary">
          Review tenants
        </Link>
      </div>
      <div className={`health-indicator ${backendHealth}`} role="status" aria-live="polite">
        <span className="health-dot" /> Backend {backendHealth === 'checking' ? 'checking' : backendHealth}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {failureError && <div className="alert alert-error" role="alert">{failureError}</div>}
      {loading && <div className="empty-state">Loading…</div>}

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="section-heading"><div><h2>Unresolved operational alerts</h2><p>Persisted worker failures requiring platform review.</p></div><strong>{operationalFailures.length}</strong></div>
        {operationalFailures.length === 0 ? <div className="empty-state">No unresolved operational alerts.</div> : <div className="table-wrap"><table><thead><tr><th>Created</th><th>Tenant</th><th>Queue</th><th>Failure code</th><th>Attempts</th><th>Resolution</th></tr></thead><tbody>
          {operationalFailures.map((failure) => <tr key={failure.id}>
            <td>{new Date(failure.createdAt).toLocaleString()}</td>
            <td>{failure.tenantName || failure.tenantId || 'Platform'}</td>
            <td>{failure.queueName}<small>{failure.jobName}</small></td>
            <td className="mono">{failure.errorCode}</td>
            <td>{failure.attemptsMade}</td>
            <td><div className="failure-resolution"><input aria-label={`Resolution note for ${failure.queueName}`} value={failureNotes[failure.id] || ''} maxLength={1000} onChange={(event) => setFailureNotes((current) => ({ ...current, [failure.id]: event.target.value }))} placeholder="Resolution note" /><button className="btn btn-secondary btn-sm" disabled={resolvingFailureId === failure.id} onClick={() => resolveFailure(failure)}>{resolvingFailureId === failure.id ? 'Saving…' : 'Resolve'}</button></div></td>
          </tr>)}
        </tbody></table></div>}
      </div>

      {report && (
        <>
          <div className="grid-3">
            <div className="metric-card">
              <div className="label">Active tenants</div>
              <div className="value">{report.totalActiveTenants}</div>
            </div>
            <div className="metric-card">
              <div className="label">Pending onboarding</div>
              <div className="value">{report.totalPendingTenants}</div>
            </div>
            <div className="metric-card">
              <div className="label">Total collected (GHS)</div>
              <div className="value">{money(report.totalCollected)}</div>
            </div>
          </div>

          <div className="panel" style={{ marginTop: 20 }}>
            <h2>Top tenants by volume</h2>
            {report.topTenantsByVolume.length === 0 ? (
              <div className="empty-state">No successful collections yet.</div>
            ) : (
              <table className="ledger">
                <thead>
                  <tr><th>Tenant</th><th>Volume</th><th>Transactions</th><th></th></tr>
                </thead>
                <tbody>
                  {report.topTenantsByVolume.map((t) => (
                    <tr key={t.tenantId}>
                      <td>{t.companyName}</td>
                      <td className="mono">{money(t.totalVolume)}</td>
                      <td className="mono">{t.transactionCount}</td>
                      <td><Link to={`/tenants/${t.tenantId}`}>View tenant →</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
