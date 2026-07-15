import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'

function money(n) {
  return Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function OperatorOverview() {
  const { user } = useOperatorAuth()
  const [tenant, setTenant] = useState(null)
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user?.tenantId) return
    setLoading(true)
    Promise.all([
      operatorApi.getTenant(user.tenantId).then(setTenant),
      operatorApi.tenantReport(user.tenantId).then(setReport)
    ])
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [user])

  return (
    <div>
      <div className="portal-header">
        <div>
          <h1>{tenant?.companyName || user?.tenantCompanyName}</h1>
          <p>Overview of your merchants' collections, payouts, and revenue.</p>
        </div>
        <Link to="/operator/merchants/new" className="btn btn-primary">Add a merchant</Link>
      </div>

      {tenant && tenant.status !== 'ACTIVE' && (
        <div className="status-banner pending" style={{ marginBottom: 16 }}>
          <span className="status-icon">i</span>
          <span>
            Your account is <strong>{tenant.status.replace('_', ' ')}</strong>. Submit your KYC/KYB
            documents under <Link to="/operator/account">Account & KYC</Link> — payments stay disabled
            until an admin reviews and approves them.
          </span>
        </div>
      )}

      {error && <div className="status-banner error"><span className="status-icon">⚠</span><span>{error}</span></div>}
      {loading && <div className="empty-state">Loading…</div>}

      {report && (
        <>
          <div className="metrics-row">
            <div className="metric">
              <div className="label">Total collection</div>
              <div className="value">GHS {money(report.totalCollected)}</div>
            </div>
            <div className="metric">
              <div className="label">Total payout</div>
              <div className="value">GHS {money(report.totalPaidOut)}</div>
            </div>
            <div className="metric">
              <div className="label">Net revenue</div>
              <div className="value">GHS {money(report.netRevenue)}</div>
            </div>
          </div>

          <div className="card">
            <h2>Transaction status</h2>
            <div className="kv-row"><span>Successful</span><span className="mono">{report.successfulCount}</span></div>
            <div className="kv-row"><span>Pending</span><span className="mono">{report.pendingCount}</span></div>
            <div className="kv-row"><span>Failed</span><span className="mono">{report.failedCount}</span></div>
          </div>

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <h2 style={{ margin: 0 }}>Merchants by volume</h2>
              <Link to="/operator/merchants" style={{ fontSize: 12.5 }}>Manage merchants →</Link>
            </div>
            {report.merchants.length === 0 ? (
              <div className="empty-state">No merchants onboarded yet.</div>
            ) : (
              <table className="ledger">
                <thead><tr><th>Merchant</th><th>Total collected</th><th>Transactions</th></tr></thead>
                <tbody>
                  {report.merchants.map((m) => (
                    <tr key={m.merchantId}>
                      <td><Link to={`/operator/merchants/${m.merchantId}`}>{m.displayName}</Link></td>
                      <td className="mono">{money(m.totalCollected)}</td>
                      <td className="mono">{m.transactionCount}</td>
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
