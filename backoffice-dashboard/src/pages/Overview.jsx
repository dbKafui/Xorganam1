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

  useEffect(() => {
    reportsApi
      .system()
      .then(setReport)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

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
      {loading && <div className="empty-state">Loading…</div>}

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
