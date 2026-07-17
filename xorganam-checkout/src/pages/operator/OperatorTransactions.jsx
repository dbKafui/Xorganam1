import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'

function money(n) {
  return Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function OperatorTransactions() {
  const { user } = useOperatorAuth()
  const [searchParams] = useSearchParams()
  const [merchants, setMerchants] = useState([])
  const [merchantId, setMerchantId] = useState(searchParams.get('merchantId') || '')
  const [status, setStatus] = useState('')
  const [type, setType] = useState('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user?.tenantId) return
    operatorApi.listMerchants(user.tenantId).then(setMerchants).catch(() => {})
  }, [user])

  useEffect(() => {
    if (!user?.tenantId) return
    setLoading(true)
    operatorApi
      .listTransactions({ tenantId: user.tenantId, merchantId: merchantId || undefined, status: status || undefined, type: type || undefined, page, pageSize: 20 })
      .then(setResult)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [user, merchantId, status, type, page])

  return (
    <div>
      <div className="portal-header">
        <div>
          <h1>Transactions</h1>
          <p>Collections, internal transfers, and payouts across all your merchants.</p>
        </div>
        <Link to="/operator/transactions/new" className="btn btn-primary">Start a collection</Link>
      </div>

      <div className="card">
        <div className="two-col">
          <div className="field">
            <label>Merchant</label>
            <select value={merchantId} onChange={(e) => { setMerchantId(e.target.value); setPage(1) }}>
              <option value="">All merchants</option>
              {merchants.map((m) => (
                <option key={m.id} value={m.id}>{m.displayName}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
              <option value="">All</option>
              <option value="PENDING">Pending</option>
              <option value="RECEIVED">Received</option>
              <option value="SWEPT_INTERNAL">Swept internal</option>
              <option value="PAID_OUT">Paid out</option>
              <option value="FAILED">Failed</option>
            </select>
          </div>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Type</label>
          <select value={type} onChange={(e) => { setType(e.target.value); setPage(1) }}>
            <option value="">All</option>
            <option value="COLLECTION">Collection</option>
            <option value="INTERNAL_TRANSFER">Internal transfer</option>
            <option value="PAYOUT">Payout</option>
          </select>
        </div>
      </div>

      {error && <div className="status-banner error"><span className="status-icon">⚠</span><span>{error}</span></div>}

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : !result || result.transactions.length === 0 ? (
          <div className="empty-state">No transactions match these filters.</div>
        ) : (
          <>
            <table className="ledger">
              <thead>
                <tr><th>Reference</th><th>Type</th><th>Amount</th><th>Status</th><th>Gateway</th><th>Date</th></tr>
              </thead>
              <tbody>
                {result.transactions.map((t) => (
                  <tr key={t.id}>
                    <td className="mono"><Link to={`/operator/transactions/${t.id}`}>{t.internalReference}</Link></td>
                    <td>{t.type.replace('_', ' ')}</td>
                    <td className="mono">{money(t.amount)} {t.currency}</td>
                    <td><span className={`status-pill ${t.status.toLowerCase()}`}>{t.status.replace('_', ' ')}</span></td>
                    <td className="mono">{t.paymentGatewayStatus || '—'}</td>
                    <td className="mono">{new Date(t.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14, fontSize: 12.5, color: 'var(--muted)' }}>
              <span>Page {result.page} of {result.totalPages}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
                <button className="btn btn-secondary btn-sm" disabled={page >= result.totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
