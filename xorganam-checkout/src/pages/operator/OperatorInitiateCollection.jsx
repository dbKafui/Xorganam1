import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'
import { clearIdempotencyKey, getOrCreateIdempotencyKey } from '../../lib/idempotency'

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
  const [form, setForm] = useState({ merchantId: '', amount: '', msisdn: '', network: '', narration: '', collectionMethod: 'MOMO', cardNumber: '', cardholderName: '', expiryDateMonth: '', expiryDateYear: '', cvv: '' })
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const idempotencyKeyRef = useRef(null)

  useEffect(() => {
    if (!user?.tenantId) return
    operatorApi.listMerchants(user.tenantId).then(setMerchants).catch(() => {})
  }, [user])

  async function handleSubmit(e) {
    e.preventDefault()
    const numericAmount = Number(form.amount)
    if (!Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > 1_000_000) {
      setError('Enter an amount greater than 0 and no greater than GHS 1,000,000.')
      return
    }
    if (!window.confirm(`Start a ${form.collectionMethod === 'MOMO' ? 'mobile money' : 'card'} collection for ${numericAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GHS for ${form.merchantId}?`)) return
    setError('')
    setResult(null)
    setBusy(true)
    try {
      const normalizedMsisdn = form.collectionMethod === 'MOMO' ? normalizeMsisdn(form.msisdn) : ''
      if (form.collectionMethod === 'MOMO' && (!normalizedMsisdn || normalizedMsisdn.length !== 12)) {
        throw new Error('Enter a valid mobile number in local or international format.')
      }
      const storageKey = `xorganam_operator_collection_key:${user.tenantId}`
      if (!idempotencyKeyRef.current) idempotencyKeyRef.current = getOrCreateIdempotencyKey(storageKey)
      const response = await operatorApi.collectForTenant(user.tenantId, {
        merchantId: form.merchantId,
        amount: Number(form.amount),
        msisdn: normalizedMsisdn || undefined,
        collectionMethod: form.collectionMethod,
        ...(form.collectionMethod === 'CARD' ? { cardNumber: form.cardNumber, cardholderName: form.cardholderName, expiryDateMonth: Number(form.expiryDateMonth), expiryDateYear: form.expiryDateYear.slice(-2), cvv: form.cvv } : {}),
        network: form.network || undefined,
        narration: form.narration || undefined
      }, idempotencyKeyRef.current)
      setResult(response)
      if (response.status === 'FAILED') {
        idempotencyKeyRef.current = null
        clearIdempotencyKey(`xorganam_operator_collection_key:${user.tenantId}`)
      }
    } catch (err) {
      setError(err.message)
      if (err.status >= 400 && err.status < 500 && err.status !== 409) {
        idempotencyKeyRef.current = null
        clearIdempotencyKey(`xorganam_operator_collection_key:${user.tenantId}`)
      }
    } finally {
      setBusy(false)
    }
  }

  function startAnotherCollection() {
    idempotencyKeyRef.current = null
    clearIdempotencyKey(`xorganam_operator_collection_key:${user.tenantId}`)
    setResult(null)
    setError('')
    setForm({ merchantId: '', amount: '', msisdn: '', network: '', narration: '', collectionMethod: 'MOMO', cardNumber: '', cardholderName: '', expiryDateMonth: '', expiryDateYear: '', cvv: '' })
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
            <div>
              <div>
                Collection <span className="mono">{result.internalReference}</span> started — status: {result.status}.
              </div>
              {result.paymentGatewayStatus && (
                <div>Gateway status: <span className="mono">{result.paymentGatewayStatus}</span></div>
              )}
              {result.message && (
                <div>Gateway message: <span className="mono">{result.message}</span></div>
              )}
              {result.status !== 'PENDING' && <button type="button" className="btn btn-secondary" onClick={startAnotherCollection}>Start another collection</button>}
              {result.redirectHtml && <iframe title="Card verification" sandbox="allow-forms allow-scripts allow-top-navigation-by-user-activation" srcDoc={(() => { try { return decodeURIComponent(escape(atob(result.redirectHtml))) } catch { return atob(result.redirectHtml) } })()} style={{ width: '100%', minHeight: 500, border: 0 }} />}
              <div>
                <Link to={`/operator/transactions/${result.id}`}>View it →</Link>
              </div>
            </div>
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
          <div className="field"><label>Collection method</label><select value={form.collectionMethod} onChange={(e) => setForm((f) => ({ ...f, collectionMethod: e.target.value }))}><option value="MOMO">Mobile Money</option><option value="CARD">Visa / Mastercard</option></select></div>
          {form.collectionMethod === 'MOMO' && <div className="field">
            <label>Customer mobile number</label>
            <input
              required
              value={form.msisdn}
              onChange={(e) => setForm((f) => ({ ...f, msisdn: e.target.value }))}
              placeholder="0551234567 or 233551234567"
            />
          </div>}
        </div>
        {form.collectionMethod === 'MOMO' && <div className="two-col">
          <div className="field">
            <label>Paypartner (optional)</label>
            <select value={form.network} onChange={(e) => setForm((f) => ({ ...f, network: e.target.value }))}>
              {PAYPARTNER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          {form.collectionMethod === 'MOMO' && <div className="field">
            <label>Narration (optional)</label>
            <input value={form.narration} onChange={(e) => setForm((f) => ({ ...f, narration: e.target.value }))} />
          </div>}
        </div>}
        {form.collectionMethod === 'CARD' && <div className="two-col"><div className="field"><label>Card number</label><input required autoComplete="cc-number" inputMode="numeric" value={form.cardNumber} onChange={(e) => setForm((f) => ({ ...f, cardNumber: e.target.value }))} /></div><div className="field"><label>Cardholder name</label><input required autoComplete="cc-name" value={form.cardholderName} onChange={(e) => setForm((f) => ({ ...f, cardholderName: e.target.value }))} /></div><div className="field"><label>Expiry month</label><input required type="number" min="1" max="12" value={form.expiryDateMonth} onChange={(e) => setForm((f) => ({ ...f, expiryDateMonth: e.target.value }))} /></div><div className="field"><label>Expiry year</label><input required inputMode="numeric" placeholder="2030" value={form.expiryDateYear} onChange={(e) => setForm((f) => ({ ...f, expiryDateYear: e.target.value }))} /></div><div className="field"><label>CVV</label><input required type="password" inputMode="numeric" autoComplete="cc-csc" value={form.cvv} onChange={(e) => setForm((f) => ({ ...f, cvv: e.target.value }))} /></div></div>}

        <button className="btn btn-primary" disabled={busy || !form.merchantId || Boolean(result)}>{busy ? 'Starting…' : 'Start collection'}</button>
      </form>
    </div>
  )
}
