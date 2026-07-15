import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { reportsApi } from '../api/reports'

function money(n) {
  return Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function Overview() {
  const { user } = useAuth()
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    reportsApi
      .system()
      .then(setReport)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
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
