import { useEffect, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { operatorApi } from '../../api/client'

function money(n) {
  return Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function OperatorTransactionDetail() {
  const { transactionId } = useParams()
  const [txn, setTxn] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [transferAmount, setTransferAmount] = useState('')
  const [payoutForm, setPayoutForm] = useState({ amount: '', accountNoOrMsisdn: '' })
  const [busy, setBusy] = useState(false)
  const [reconciling, setReconciling] = useState(false)

  const load = useCallback(() => {
    operatorApi.transactionDetail(transactionId).then(setTxn).catch((err) => setError(err.message))
  }, [transactionId])

  useEffect(() => {
    load()
  }, [load])

  if (!txn) {
    return <div className="empty-state">{error || 'Loading…'}</div>
  }

  const hasTransfer = txn.childTransactions.some((c) => c.type === 'INTERNAL_TRANSFER')
  const hasPayout = txn.childTransactions.some((c) => c.type === 'PAYOUT')
  const canManuallyProcess = txn.type === 'COLLECTION' && txn.status === 'RECEIVED'
  const canPayout = txn.type === 'COLLECTION' && txn.status === 'SWEPT_INTERNAL'

  async function handleReconcile() {
    setError('')
    setNotice('')
    setReconciling(true)
    try {
      const updated = await operatorApi.reconcile(txn.id)
      setNotice(updated.status === 'RECEIVED' ? 'Still pending upstream — nothing changed yet.' : `Reconciled: now ${updated.status}.`)
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setReconciling(false)
    }
  }

  async function startTransfer(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      await operatorApi.internalTransfer({ sourceTransactionId: txn.id, amount: Number(transferAmount) || undefined })
      setNotice('Internal transfer initiated.')
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function startPayout(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      await operatorApi.payout({
        sourceTransactionId: txn.id,
        amount: Number(payoutForm.amount) || undefined,
        accountNoOrMsisdn: payoutForm.accountNoOrMsisdn || undefined
      })
      setNotice('Payout initiated.')
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="portal-header">
        <div>
          <h1 style={{ fontFamily: 'var(--font-mono)' }}>{txn.internalReference}</h1>
          <p>{txn.type.replace('_', ' ')} · <span className={`status-pill ${txn.status.toLowerCase()}`}>{txn.status.replace('_', ' ')}</span></p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {txn.status === 'RECEIVED' && txn.type === 'COLLECTION' && (
            <button className="btn btn-secondary" onClick={handleReconcile} disabled={reconciling}>
              {reconciling ? 'Checking…' : 'Check status now'}
            </button>
          )}
          <Link to="/operator/transactions" className="btn btn-secondary">Back</Link>
        </div>
      </div>

      {error && <div className="status-banner error"><span className="status-icon">⚠</span><span>{error}</span></div>}
      {notice && <div className="status-banner success"><span className="status-icon">✓</span><span>{notice}</span></div>}

      <div className="metrics-row">
        <div className="metric"><div className="label">Amount</div><div className="value">{money(txn.amount)} {txn.currency}</div></div>
        <div className="metric"><div className="label">Fees</div><div className="value">{money(txn.fees)}</div></div>
        <div className="metric"><div className="label">Manually triggered</div><div className="value" style={{ fontSize: 15 }}>{txn.manuallyTriggered ? 'Yes' : 'No'}</div></div>
      </div>

      <div className="card">
        <h2>Details</h2>
        <div className="kv-row"><span>Eganow reference</span><span className="mono">{txn.eganowReference || '—'}</span></div>
        {txn.failureReason && <div className="kv-row"><span>Failure reason</span><span>{txn.failureReason}</span></div>}
        <div className="kv-row"><span>Created</span><span className="mono">{new Date(txn.createdAt).toLocaleString()}</span></div>
        {txn.completedAt && <div className="kv-row"><span>Completed</span><span className="mono">{new Date(txn.completedAt).toLocaleString()}</span></div>}
      </div>

      {txn.childTransactions.length > 0 && (
        <div className="card">
          <h2>Linked transactions</h2>
          <table className="ledger">
            <thead><tr><th>Reference</th><th>Type</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {txn.childTransactions.map((c) => (
                <tr key={c.id}>
                  <td className="mono"><Link to={`/operator/transactions/${c.id}`}>{c.internalReference}</Link></td>
                  <td>{c.type.replace('_', ' ')}</td>
                  <td className="mono">{money(c.amount)} {c.currency}</td>
                  <td><span className={`status-pill ${c.status.toLowerCase()}`}>{c.status.replace('_', ' ')}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManuallyProcess && !hasTransfer && (
        <form className="card" onSubmit={startTransfer}>
          <h2>Manual internal transfer</h2>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>
            Moves funds from the collection wallet to the payout wallet for this transaction.
          </p>
          <div className="field">
            <label>Amount</label>
            <input type="number" step="0.01" placeholder={txn.amount} value={transferAmount} onChange={(e) => setTransferAmount(e.target.value)} />
          </div>
          <button className="btn btn-primary" disabled={busy}>Start internal transfer</button>
        </form>
      )}

      {canPayout && hasTransfer && !hasPayout && (
        <form className="card" onSubmit={startPayout}>
          <h2>Manual payout</h2>
          <div className="two-col">
            <div className="field">
              <label>Amount</label>
              <input type="number" step="0.01" placeholder={txn.amount} value={payoutForm.amount} onChange={(e) => setPayoutForm((f) => ({ ...f, amount: e.target.value }))} />
            </div>
            <div className="field">
              <label>Destination (defaults to merchant's MoMo number)</label>
              <input value={payoutForm.accountNoOrMsisdn} onChange={(e) => setPayoutForm((f) => ({ ...f, accountNoOrMsisdn: e.target.value }))} placeholder="Leave blank to use the merchant's number on file" />
            </div>
          </div>
          <button className="btn btn-primary" disabled={busy}>Start payout</button>
        </form>
      )}
    </div>
  )
}
