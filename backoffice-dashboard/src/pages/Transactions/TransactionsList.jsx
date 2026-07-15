import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { tenantsApi } from '../../api/tenants'
import { merchantsApi } from '../../api/merchants'
import { transactionsApi } from '../../api/transactions'
import StatusChip from '../../components/StatusChip'

function money(n) {
  return Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function TransactionsList() {
  const [searchParams] = useSearchParams()
  const [tenants, setTenants] = useState([])
  const [merchants, setMerchants] = useState([])
  const [tenantId, setTenantId] = useState(searchParams.get('tenantId') || '')
  const [merchantId, setMerchantId] = useState('')
  const [status, setStatus] = useState('')
  const [type, setType] = useState('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    tenantsApi.list().then(setTenants).catch(() => {})
  }, [])

  useEffect(() => {
    if (!tenantId) { setMerchants([]); return }
    merchantsApi.list(tenantId).then(setMerchants).catch(() => {})
  }, [tenantId])

  useEffect(() => {
    if (!tenantId) return
    setLoading(true)
    setError('')
    transactionsApi
      .list({ tenantId, merchantId: merchantId || undefined, status: status || undefined, type: type || undefined, page, pageSize: 20 })
      .then(setResult)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [tenantId, merchantId, status, type, page])

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Transactions</h1>
          <p>Browse any tenant's collections, transfers, and payouts.</p>
        </div>
      </div>

      <div className="panel">
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="field">
            <label>Tenant</label>
            <select value={tenantId} onChange={(e) => { setTenantId(e.target.value); setMerchantId(''); setPage(1) }}>
              <option value="">Select a tenant…</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.companyName}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Merchant</label>
            <select value={merchantId} onChange={(e) => { setMerchantId(e.target.value); setPage(1) }} disabled={!tenantId}>
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
              <option value="RECEIVED">Received</option>
              <option value="SWEPT_INTERNAL">Swept internal</option>
              <option value="PAID_OUT">Paid out</option>
              <option value="FAILED">Failed</option>
            </select>
          </div>
          <div className="field">
            <label>Type</label>
            <select value={type} onChange={(e) => { setType(e.target.value); setPage(1) }}>
              <option value="">All</option>
              <option value="COLLECTION">Collection</option>
              <option value="INTERNAL_TRANSFER">Internal transfer</option>
              <option value="PAYOUT">Payout</option>
            </select>
          </div>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {!tenantId ? (
        <div className="empty-state">Select a tenant to view its transactions.</div>
      ) : (
        <div className="panel">
          {loading ? (
            <div className="empty-state">Loading…</div>
          ) : !result || result.transactions.length === 0 ? (
            <div className="empty-state">No transactions match these filters.</div>
          ) : (
            <>
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Reference</th><th>Type</th><th>Amount</th><th>Status</th><th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {result.transactions.map((t) => (
                    <tr key={t.id}>
                      <td className="mono"><Link to={`/transactions/${t.id}`}>{t.internalReference}</Link></td>
                      <td>{t.type.replace('_', ' ')}</td>
                      <td className="mono">{money(t.amount)} {t.currency}</td>
                      <td><StatusChip status={t.status} /></td>
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
      )}
    </div>
  )
}
