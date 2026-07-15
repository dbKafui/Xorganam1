import { useEffect, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { transactionsApi } from '../../api/transactions'
import StatusChip from '../../components/StatusChip'

function money(n) {
  return Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function TransactionDetail() {
  const { transactionId } = useParams()
  const [txn, setTxn] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reconciling, setReconciling] = useState(false)

  const load = useCallback(() => {
    transactionsApi.detail(transactionId).then(setTxn).catch((err) => setError(err.message))
  }, [transactionId])

  useEffect(() => {
    load()
  }, [load])

  async function handleReconcile() {
    setError('')
    setNotice('')
    setReconciling(true)
    try {
      const updated = await transactionsApi.reconcile(transactionId)
      setNotice(updated.status === 'RECEIVED' ? 'Still pending upstream — nothing changed yet.' : `Reconciled: now ${updated.status}.`)
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setReconciling(false)
    }
  }

  if (!txn) {
    return <div className="empty-state">{error || 'Loading…'}</div>
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="mono">{txn.internalReference}</h1>
          <p>{txn.type.replace('_', ' ')} · <StatusChip status={txn.status} /></p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {txn.status === 'RECEIVED' && (
            <button className="btn btn-secondary" onClick={handleReconcile} disabled={reconciling}>
              {reconciling ? 'Checking…' : 'Check status now'}
            </button>
          )}
          <Link to="/transactions" className="btn btn-secondary">Back to transactions</Link>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <div className="panel">
        <h2>Details</h2>
        <div className="grid-3">
          <div className="metric-card"><div className="label">Amount</div><div className="value">{money(txn.amount)} {txn.currency}</div></div>
          <div className="metric-card"><div className="label">Fees</div><div className="value">{money(txn.fees)}</div></div>
          <div className="metric-card"><div className="label">Manually triggered</div><div className="value" style={{ fontSize: 15 }}>{txn.manuallyTriggered ? 'Yes' : 'No'}</div></div>
        </div>
        <div className="form-grid single" style={{ marginTop: 16 }}>
          <div><strong>Eganow reference:</strong> <span className="mono">{txn.eganowReference || '—'}</span></div>
          {txn.failureReason && <div><strong>Failure reason:</strong> {txn.failureReason}</div>}
          <div><strong>Notification sent:</strong> {txn.notificationSent ? 'Yes' : 'No'}</div>
          <div><strong>Created:</strong> <span className="mono">{new Date(txn.createdAt).toLocaleString()}</span></div>
          {txn.completedAt && <div><strong>Completed:</strong> <span className="mono">{new Date(txn.completedAt).toLocaleString()}</span></div>}
        </div>
      </div>

      {txn.childTransactions.length > 0 && (
        <div className="panel">
          <h2>Linked transactions</h2>
          <table className="ledger">
            <thead><tr><th>Reference</th><th>Type</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {txn.childTransactions.map((c) => (
                <tr key={c.id}>
                  <td className="mono"><Link to={`/transactions/${c.id}`}>{c.internalReference}</Link></td>
                  <td>{c.type.replace('_', ' ')}</td>
                  <td className="mono">{money(c.amount)} {c.currency}</td>
                  <td><StatusChip status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
