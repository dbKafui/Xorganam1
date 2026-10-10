import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'

import { formatCurrencyAmount } from '../../../../shared/currency.js'
function money(n) {
  return formatCurrencyAmount(n ?? 0, 'GHS')
}

export default function OperatorOverview() {
  const { user } = useOperatorAuth()
  const [tenant, setTenant] = useState(null)
  const [branch, setBranch] = useState(null)
  const [report, setReport] = useState(null)
  const [health, setHealth] = useState(null)
  const [failedJobs, setFailedJobs] = useState([])
  const [failedJobsError, setFailedJobsError] = useState('')
  const [operationalFailures, setOperationalFailures] = useState([])
  const [operationalFailuresError, setOperationalFailuresError] = useState('')
  const [failureNotes, setFailureNotes] = useState({})
  const [resolvingFailureId, setResolvingFailureId] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user?.tenantId) return
    setLoading(true)
    const requests = user.role === 'TENANT_BRANCH_MANAGER'
      ? [operatorApi.getMerchant(user.merchantId).then(setBranch)]
      : [operatorApi.getTenant(user.tenantId).then(setTenant), operatorApi.tenantReport(user.tenantId).then(setReport)]
    Promise.all(requests)
      .then(() => Promise.all([
        operatorApi.getOperationalHealth(user.tenantId),
        operatorApi.getFailedQueueJobs(user.tenantId),
        operatorApi.getOperationalFailures(user.tenantId)
      ]))
      .then(([currentHealth, result, durableFailures]) => {
        setHealth(currentHealth)
        setFailedJobs(result.failures || [])
        setOperationalFailures(durableFailures || [])
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [user])

  async function resolveFailure(failure) {
    const resolutionNote = String(failureNotes[failure.id] || '').trim()
    if (resolutionNote.length < 5) {
      setOperationalFailuresError('Add a resolution note of at least five characters.')
      return
    }
    setResolvingFailureId(failure.id)
    setOperationalFailuresError('')
    try {
      await operatorApi.resolveOperationalFailure(failure.id, user.tenantId, resolutionNote)
      setOperationalFailures((current) => current.filter((item) => item.id !== failure.id))
      setFailureNotes((current) => { const next = { ...current }; delete next[failure.id]; return next })
    } catch (requestError) {
      setOperationalFailuresError(requestError.message)
    } finally {
      setResolvingFailureId('')
    }
  }

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

      {health && (
        <section className="card" aria-labelledby="operations-status-heading">
          <div className="section-heading" style={{ marginBottom: 12 }}>
            <div>
              <h2 id="operations-status-heading" style={{ margin: 0 }}>Operations status</h2>
              <p className="subtle">Health of database, Redis, queued work, and configured integrations.</p>
            </div>
            <span className={`status-pill ${health.status === 'healthy' ? 'success' : 'pending'}`} aria-live="polite">
              {health.status === 'healthy' ? 'Healthy' : 'Degraded'}
            </span>
          </div>
          <div className="metrics-row">
            <div className="metric vendor-metric">
              <div className="label">Database</div>
              <div className="value" aria-label={health.database.available ? 'Database available' : 'Database unavailable'}>{health.database.available ? 'Online' : 'Unavailable'}</div>
            </div>
            <div className="metric vendor-metric">
              <div className="label">Redis</div>
              <div className="value" aria-label={health.redis.available ? 'Redis available' : 'Redis unavailable'}>{health.redis.available ? 'Online' : 'Unavailable'}</div>
            </div>
            <div className="metric vendor-metric">
              <div className="label">Queued work</div>
              <div className="value">{health.queuedJobs}</div>
            </div>
            <div className="metric vendor-metric">
              <div className="label">Failed jobs</div>
              <div className="value">{health.failedJobs}</div>
            </div>
          </div>
          {health.criticalIssues.length > 0 && <div className="status-banner pending" role="alert"><span className="status-icon">!</span><span>{health.criticalIssues.join(' ')}</span></div>}
          <p className="subtle">{health.notice}</p>
        </section>
      )}

      <section className="card" aria-labelledby="failed-queue-jobs-heading">
        <div className="section-heading" style={{ marginBottom: 12 }}>
          <div>
            <h2 id="failed-queue-jobs-heading" style={{ margin: 0 }}>Failed queue jobs</h2>
            <p className="subtle">Recent worker failures requiring review.</p>
          </div>
          <span className="status-pill pending" aria-live="polite">{failedJobs.length}</span>
        </div>
        {failedJobsError ? <div className="status-banner error"><span className="status-icon">⚠</span><span>{failedJobsError}</span></div> : null}
        {failedJobs.length === 0 ? (
          <div className="empty-state">No failed jobs recorded.</div>
        ) : (
          <div className="table-wrap">
            <table className="ledger">
              <thead><tr><th>Queue</th><th>Job</th><th>Attempts</th><th>Failed</th><th>Reason</th></tr></thead>
              <tbody>
                {failedJobs.map((job) => (
                  <tr key={`${job.queue}:${job.id}`}>
                    <td>{job.queue}</td>
                    <td className="mono">{job.name}</td>
                    <td className="mono">{job.attemptsMade}</td>
                    <td className="mono">{job.finishedAt ? new Date(job.finishedAt).toLocaleString() : 'Unknown'}</td>
                    <td>{job.failedReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="operational-failures-heading">
        <div className="section-heading" style={{ marginBottom: 12 }}>
          <div>
            <h2 id="operational-failures-heading" style={{ margin: 0 }}>Unresolved operational alerts</h2>
            <p className="subtle">Durable worker failures affecting tenant financial or order workflows.</p>
          </div>
          <span className="status-pill pending" aria-live="polite">{operationalFailures.length}</span>
        </div>
        {operationalFailuresError && <div className="status-banner error" role="alert">{operationalFailuresError}</div>}
        {operationalFailures.length === 0 ? <div className="empty-state">No unresolved operational alerts.</div> : (
          <div className="table-wrap"><table className="ledger">
            <thead><tr><th>Created</th><th>Queue</th><th>Failure code</th><th>Attempts</th><th>Transaction</th><th>Resolution</th></tr></thead>
            <tbody>{operationalFailures.map((failure) => <tr key={failure.id}>
              <td>{new Date(failure.createdAt).toLocaleString()}</td>
              <td>{failure.queueName}<small>{failure.jobName}</small></td>
              <td className="mono">{failure.errorCode}</td>
              <td className="mono">{failure.attemptsMade}</td>
              <td>{failure.transactionId ? <Link to={`/operator/transactions/${failure.transactionId}`}>{failure.transactionId}</Link> : '—'}</td>
              <td>{user.role === 'TENANT_BRANCH_MANAGER' ? 'Ask an account admin to review.' : <div className="operational-failure-resolution">
                <input aria-label={`Resolution note for ${failure.queueName} job`} value={failureNotes[failure.id] || ''} onChange={(event) => setFailureNotes((current) => ({ ...current, [failure.id]: event.target.value }))} placeholder="Resolution note" maxLength={1000} />
                <button type="button" className="btn btn-secondary btn-sm" disabled={resolvingFailureId === failure.id} onClick={() => resolveFailure(failure)}>{resolvingFailureId === failure.id ? 'Saving…' : 'Resolve'}</button>
              </div>}</td>
            </tr>)}</tbody>
          </table></div>
        )}
      </section>

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
