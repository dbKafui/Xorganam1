import { useCallback, useEffect, useState } from 'react'
import { institutionApi } from '../api/client.js'
import PageHeader from '../components/PageHeader.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import { EmptyState, ErrorMessage, LoadingState } from '../components/Feedback.jsx'
import { normalizePaymentStatus } from '../lib/statusContract.js'
import { formatCurrencyAmount } from '../../../shared/currency.js'

const amount = (value) => formatCurrencyAmount(value || 0, 'GHS')

function describeFailure(row) {
  const statuses = [row.institution_leg_status, row.vendor_leg_status].filter(Boolean)
  const failures = [row.institution_failure_reason, row.vendor_failure_reason, row.failure_reason].filter(Boolean)
  if (failures.length === 0) return null
  return {
    status: statuses.find((status) => status === 'FAILED') || null,
    message: failures[0]
  }
}

export default function Reconciliation() {
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [state, setState] = useState('ALL')
  const load = useCallback(() => institutionApi.reconciliation().then((data) => setRecords(Array.isArray(data) ? data : [])), [])

  useEffect(() => {
    load().catch((requestError) => setError(requestError.message)).finally(() => setLoading(false))
  }, [load])

  const visible = records.filter((row) => {
    const status = row.reconciliation_state || row.sweep_status || row.status || ''
    if (state !== 'ALL' && status !== state) return false
    return !search || `${row.tenant_name || ''} ${row.merchant_name || ''} ${row.tenant_id || ''} ${row.merchant_id || ''} ${row.sweep_transaction_id || ''}`.toLowerCase().includes(search.toLowerCase())
  })

  return (
    <>
      <PageHeader eyebrow="FINANCIAL OPERATIONS / LEDGER" title="Reconciliation" description="Monitor settled, pending, accrued-unswept, and partially settled institution amounts." action={<button className="button button-outline" onClick={() => { setLoading(true); load().catch((requestError) => setError(requestError.message)).finally(() => setLoading(false)) }}>Refresh ↻</button>} />
      <ErrorMessage>{error}</ErrorMessage>
      <section className="surface">
        <div className="toolbar">
          <label className="search-field"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tenant, merchant, or reference" /></label>
          <select className="compact-select" value={state} onChange={(event) => setState(event.target.value)}><option value="ALL">All states</option><option value="SETTLED">Settled</option><option value="PENDING">Pending</option><option value="ACCRUED_UNSWEPT">Accrued unswept</option><option value="PARTIALLY_SETTLED">Partially settled</option></select>
        </div>
        {loading ? <LoadingState /> : visible.length ? <div className="table-wrap"><table><thead><tr><th>Period / reference</th><th>Tenant</th><th>Merchant</th><th>Institution amount</th><th>Vendor amount</th><th>Settlement legs</th><th>State</th></tr></thead><tbody>
          {visible.map((row, index) => {
            const status = normalizePaymentStatus(row.reconciliation_state || row.sweep_status || row.status || 'PENDING')
            const legFailure = describeFailure(row)
            return <tr key={row.sweep_transaction_id || row.parent_transaction_id || index}>
              <td><strong>{row.period_key ? new Date(`${row.period_key}T00:00:00`).toLocaleDateString() : 'Transaction'}</strong><small className="mono">{(row.sweep_transaction_id || row.parent_transaction_id || '').slice(0, 12)}</small></td>
              <td className="mono">{row.tenant_name || row.tenant_id || '—'}</td><td className="mono">{row.merchant_name || row.merchant_id || '—'}</td>
              <td className="mono">GHS {amount(row.institution_amount ?? row.pending_accrual_amount)}</td><td className="mono">GHS {amount(row.vendor_amount)}</td>
              <td><span className="leg-summary">I: {row.institution_leg_status || '—'}<br />V: {row.vendor_leg_status || '—'}</span>{legFailure && <small className="failure-reason">{legFailure.status ? `Failed leg: ${legFailure.status}.` : ''} {legFailure.message}</small>}</td>
              <td><StatusBadge value={status} />{status === 'PARTIALLY_SETTLED' && <small className="footnote">Review the failed leg before making further payouts or retries.</small>}</td>
            </tr>
          })}
        </tbody></table></div> : <EmptyState title="No reconciliation records">Settlement records will be listed here when available.</EmptyState>}
      </section>
      <p className="footnote">Amounts and statuses are displayed as returned by the institution reconciliation API. Verify ledger data before using it for external financial reporting.</p>
    </>
  )
}
