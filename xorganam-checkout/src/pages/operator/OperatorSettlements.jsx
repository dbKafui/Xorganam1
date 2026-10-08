import { useCallback, useEffect, useState } from 'react'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'

function amount(value) {
  return Number(value ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function OperatorSettlements() {
  const { user } = useOperatorAuth()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const statusCounts = rows.reduce((counts, row) => {
    const status = String(row.sweep_status || 'UNKNOWN')
    counts[status] = (counts[status] || 0) + 1
    return counts
  }, {})
  const pendingAccrual = rows.reduce((total, row) => total + Number(row.pending_accrual_amount || 0), 0)
  const sweptAccrual = rows.reduce((total, row) => total + Number(row.swept_accrual_amount || 0), 0)
  const maxAccrual = Math.max(pendingAccrual, sweptAccrual, 1)

  const refresh = useCallback(async () => {
    if (!user?.tenantId) return
    setError('')
    try {
      const result = await operatorApi.getPeriodicSettlementReconciliation(user.tenantId)
      setRows(Array.isArray(result) ? result : [])
    } catch (requestError) { setError(requestError.message) }
    finally { setLoading(false) }
  }, [user?.tenantId])

  useEffect(() => { refresh() }, [refresh])

  async function runDue() {
    if (!window.confirm('Queue all due periodic settlements for this tenant? This may create financial ledger entries and should only be done during an authorized settlement window.')) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await operatorApi.runPeriodicSettlements(user.tenantId)
      setNotice(`Settlement run queued${result?.jobId ? ` (${result.jobId})` : ''}. This page will show ledger updates after the worker processes it.`)
    } catch (requestError) { setError(requestError.message) }
    finally { setBusy(false) }
  }

  return <div>
    <header className="portal-header"><div><h1>Periodic settlements</h1><p>Review institution sweep results and queue due settlements for this tenant.</p></div>
      <button className="btn btn-primary" disabled={busy || !user?.tenantId} onClick={runDue}>{busy ? 'Queueing…' : 'Run due settlements'}</button>
    </header>
    {error && <div className="status-banner error" role="alert"><span className="status-icon">!</span><span>{error}</span></div>}
    {notice && <div className="status-banner pending" role="status"><span className="status-icon">✓</span><span>{notice}</span></div>}
    {!loading && rows.length > 0 && <section className="settlement-visual-summary" aria-label="Settlement dashboard">
      <div>
        <h2>Sweep status</h2>
        {['PENDING', 'ACCRUED_UNSWEPT', 'PARTIALLY_SETTLED', 'SETTLED'].map((status) => {
          const count = statusCounts[status] || 0
          return <div className="settlement-status-row" key={status}>
            <span>{status.replaceAll('_', ' ')}</span>
            <div className="settlement-bar-track" role="progressbar" aria-label={`${status.replaceAll('_', ' ')} sweeps`} aria-valuemin="0" aria-valuemax={rows.length} aria-valuenow={count}>
              <span className={`settlement-bar ${status.toLowerCase()}`} style={{ width: `${count / rows.length * 100}%` }} />
            </div>
            <strong>{count}</strong>
          </div>
        })}
      </div>
      <div>
        <h2>Accrual movement</h2>
        <div className="settlement-accrual-row"><span>Pending</span><strong>GHS {amount(pendingAccrual)}</strong></div>
        <div className="settlement-bar-track" role="progressbar" aria-label="Pending accrual amount" aria-valuemin="0" aria-valuemax={maxAccrual} aria-valuenow={pendingAccrual}>
          <span className="settlement-bar pending" style={{ width: `${pendingAccrual / maxAccrual * 100}%` }} />
        </div>
        <div className="settlement-accrual-row"><span>Swept</span><strong>GHS {amount(sweptAccrual)}</strong></div>
        <div className="settlement-bar-track" role="progressbar" aria-label="Swept accrual amount" aria-valuemin="0" aria-valuemax={maxAccrual} aria-valuenow={sweptAccrual}>
          <span className="settlement-bar settled" style={{ width: `${sweptAccrual / maxAccrual * 100}%` }} />
        </div>
      </div>
    </section>}
    <section className="card">
      <div className="section-heading"><div><h2>Sweep reconciliation</h2><p>Settlement legs recorded by the backend worker.</p></div><button className="btn btn-secondary" disabled={loading} onClick={refresh}>Refresh</button></div>
      {loading ? <div className="empty-state" aria-live="polite">Loading settlement history…</div> : rows.length === 0 ? <div className="empty-state">No periodic settlement records yet.</div> :
        <div className="table-scroll"><table className="ledger"><thead><tr><th>Period</th><th>Merchant</th><th>Institution</th><th>Institution amount</th><th>Vendor amount</th><th>Institution leg</th><th>Vendor leg</th><th>Status</th><th>Updated</th></tr></thead><tbody>
          {rows.map((row) => <tr key={row.sweep_transaction_id}><td className="mono">{row.period_key}</td><td>{row.merchant_name || row.merchant_id}</td><td>{row.institution_name || row.institution_id}</td>
            <td className="mono">GHS {amount(row.institution_amount)}</td><td className="mono">GHS {amount(row.vendor_amount)}</td>
            <td>{row.institution_leg_status}</td><td>{row.vendor_leg_status}</td><td><strong>{row.sweep_status}</strong>{row.failure_reason && <small className="table-note">{row.failure_reason}</small>}</td>
            <td>{row.updated_at ? new Date(row.updated_at).toLocaleString() : '—'}</td></tr>)}
        </tbody></table></div>}
    </section>
  </div>
}
