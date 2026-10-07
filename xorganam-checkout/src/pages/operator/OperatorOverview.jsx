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
  const [branch, setBranch] = useState(null)
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user?.tenantId) return
    setLoading(true)
    const requests = user.role === 'TENANT_BRANCH_MANAGER'
      ? [operatorApi.getMerchant(user.merchantId).then(setBranch)]
      : [operatorApi.getTenant(user.tenantId).then(setTenant), operatorApi.tenantReport(user.tenantId).then(setReport)]
    Promise.all(requests)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [user])

  return (
    <div>
      <div className="portal-header overview-welcome">
        <div>
          <span className="eyebrow-label">YOUR BUSINESS AT A GLANCE</span>
          <h1>Welcome back, {branch?.displayName || tenant?.companyName || user?.tenantCompanyName || 'Vendor'}</h1>
          <p>{user?.role === 'TENANT_BRANCH_MANAGER' ? 'Your branch activity and settings.' : 'Manage payments, financial partners and your customer storefront from one place.'}</p>
        </div>
        {user?.role !== 'TENANT_BRANCH_MANAGER' && <Link to="/operator/merchants/new" className="btn btn-primary">＋ Add a branch</Link>}
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

      <section className="vendor-actions" aria-label="Vendor tools">
        <Link to="/operator/institutions" className="vendor-action-card"><span className="vendor-action-icon finance">◇</span><span><small>FINANCIAL PARTNERS</small><strong>Loans & savings</strong><em>Browse packages, apply and manage repayments or savings.</em></span><b>→</b></Link>
        <Link to="/operator/credit-plans" className="vendor-action-card"><span className="vendor-action-icon credit">▤</span><span><small>SELL ON TERMS</small><strong>Hire-purchase</strong><em>Create installment plans and follow collections.</em></span><b>→</b></Link>
        <Link to="/operator/storefront" className="vendor-action-card"><span className="vendor-action-icon shop">▣</span><span><small>ONLINE STORE</small><strong>Catalog & storefront</strong><em>Manage products, stock, orders and storefront preview.</em></span><b>→</b></Link>
      </section>

      {report && (
        <>
          <div className="metrics-row">
              <div className="metric vendor-metric">
              <div className="label">Total collection</div>
              <div className="value">GHS {money(report.totalCollected)}</div>
            </div>
            <div className="metric vendor-metric">
              <div className="label">Total payout</div>
              <div className="value">GHS {money(report.totalPaidOut)}</div>
            </div>
            <div className="metric vendor-metric">
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
      {branch && <div className="card">
        <h2>Branch settings</h2>
        <div className="kv-row"><span>How you get paid</span><strong>{branch.payoutMode === 'AUTO_SWEEP' ? 'We move your money automatically' : 'You control when it moves'}</strong></div>
        <div className="kv-row"><span>Eganow account setup</span><strong>{branch.accountSetupStatus === 'ACTIVE' ? 'Active' : 'Pending'}</strong></div>
        <Link to={`/operator/merchants/${branch.id}`} className="btn btn-secondary">View branch details</Link>
      </div>}
    </div>
  )
}
