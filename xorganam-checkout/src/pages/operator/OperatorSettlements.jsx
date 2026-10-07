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
