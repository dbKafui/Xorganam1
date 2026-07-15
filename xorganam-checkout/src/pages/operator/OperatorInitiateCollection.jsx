import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'

const PAYPARTNER_OPTIONS = [
  { value: '', label: 'Auto-detect from merchant profile' },
  { value: 'MTN', label: 'MTN' },
  { value: 'TCELGH', label: 'TCELGH (Vodafone)' },
  { value: 'ATGH', label: 'ATGH (AirtelTigo)' }
]

function normalizeMsisdn(rawMsisdn) {
  if (!rawMsisdn) return ''
  const digits = String(rawMsisdn).trim().replace(/\D/g, '')
  if (digits.startsWith('0') && digits.length === 10) return `233${digits.slice(1)}`
  if (digits.startsWith('233') && digits.length === 12) return digits
  if (digits.startsWith('2330') && digits.length === 13) return `233${digits.slice(4)}`
  if (digits.length === 9) return `233${digits}`
  return digits
}

export default function OperatorInitiateCollection() {
  const { user } = useOperatorAuth()
  const [merchants, setMerchants] = useState([])
  const [form, setForm] = useState({ merchantId: '', amount: '', msisdn: '', network: '', narration: '' })
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!user?.tenantId) return
    operatorApi.listMerchants(user.tenantId).then(setMerchants).catch(() => {})
  }, [user])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setResult(null)
    setBusy(true)
    try {
      const normalizedMsisdn = normalizeMsisdn(form.msisdn)
      if (!normalizedMsisdn || normalizedMsisdn.length !== 12) {
        throw new Error('Enter a valid mobile number in local or international format.')
      }
      const response = await operatorApi.collect({
        merchantId: form.merchantId,
        amount: Number(form.amount),
        msisdn: normalizedMsisdn,
        network: form.network || undefined,
        narration: form.narration || undefined
      })
      setResult(response)
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
          <h1>Start a collection</h1>
          <p>Manually push a payment prompt to a customer's phone on behalf of one of your merchants.</p>
        </div>
        <Link to="/operator/transactions" className="btn btn-secondary">Back to transactions</Link>
      </div>

      <form className="card" onSubmit={handleSubmit}>
        {error && <div className="status-banner error"><span className="status-icon">⚠</span><span>{error}</span></div>}
        {result && (
          <div className="status-banner success">
            <span className="status-icon">✓</span>
            <span>
              Collection <span className="mono">{result.internalReference}</span> started — status: {result.status}.{' '}
              <Link to={`/operator/transactions/${result.id}`}>View it →</Link>
            </span>
          </div>
        )}

        <div className="field">
          <label>Merchant</label>
          <select required value={form.merchantId} onChange={(e) => setForm((f) => ({ ...f, merchantId: e.target.value }))}>
            <option value="">Select a merchant…</option>
            {merchants.map((m) => (
              <option key={m.id} value={m.id}>{m.displayName}</option>
            ))}
          </select>
        </div>

        <div className="two-col">
          <div className="field">
            <label>Amount (GHS)</label>
            <input required type="number" step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
          </div>
          <div className="field">
            <label>Customer mobile number</label>
            <input
              required
              value={form.msisdn}
              onChange={(e) => setForm((f) => ({ ...f, msisdn: e.target.value }))}
              placeholder="0551234567 or 233551234567"
            />
          </div>
        </div>
        <div className="two-col">
          <div className="field">
            <label>Paypartner (optional)</label>
            <select value={form.network} onChange={(e) => setForm((f) => ({ ...f, network: e.target.value }))}>
              {PAYPARTNER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Narration (optional)</label>
            <input value={form.narration} onChange={(e) => setForm((f) => ({ ...f, narration: e.target.value }))} />
          </div>
        </div>

        <button className="btn btn-primary" disabled={busy || !form.merchantId}>{busy ? 'Starting…' : 'Start collection'}</button>
      </form>
    </div>
  )
}
