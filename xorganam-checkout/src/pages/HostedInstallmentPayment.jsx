import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { publicApi } from '../api/client'
import { createIdempotencyKey } from '../lib/idempotency'

import { formatCurrencyAmount } from '../../../shared/currency.js'
function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '')
  if (digits.startsWith('0') && digits.length === 10) return `233${digits.slice(1)}`
  if (digits.startsWith('233') && digits.length === 12) return digits
  if (digits.length === 9) return `233${digits}`
  return ''
}

export default function HostedInstallmentPayment() {
  const { installmentToken } = useParams()
  const [installment, setInstallment] = useState(null)
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(true)
  const [paying, setPaying] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const idempotencyStorageKey = `xorganam_hosted_installment_key:${installmentToken}`
  const idempotencyKey = useRef(sessionStorage.getItem(idempotencyStorageKey))
  const [attemptStarted, setAttemptStarted] = useState(false)

  useEffect(() => {
    publicApi.getCreditInstallment(installmentToken)
      .then(setInstallment)
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false))
  }, [installmentToken])

  async function submit(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    const msisdn = normalizePhone(phone)
    if (!msisdn) return setError('Enter a valid mobile number.')
    setPaying(true)
    try {
      if (!idempotencyKey.current) idempotencyKey.current = getOrCreateIdempotencyKey(idempotencyStorageKey)
      const result = await publicApi.payCreditInstallment(installmentToken, { msisdn }, idempotencyKey.current)
      setNotice(result.message || 'Approve the payment prompt on your phone.')
      setAttemptStarted(true)
      if (result.status === 'FAILED') {
        idempotencyKey.current = null
        clearIdempotencyKey(idempotencyStorageKey)
        setAttemptStarted(false)
      }
    } catch (requestError) {
      setError(requestError.message)
      if (requestError.status === 409) setAttemptStarted(true)
    } finally { setPaying(false) }
  }

  return <div className="page">
    <div className="brand"><span className="mark">XORGANAM</span><span className="tag">Installment payment</span></div>
    <section className="pay-card">
      {loading ? <p>Loading payment details…</p> : !installment ? <>
        <h1>Payment link unavailable</h1><p>{error || 'This installment is no longer available.'}</p>
      </> : <>
        <p className="merchant">{installment.merchantName}</p>
        <h1>Installment {installment.installmentNumber}</h1>
        <div className="receipt">
          <div className="receipt-row"><span>Amount due</span><strong className="mono">{formatCurrencyAmount(installment.amountDue, 'GHS')}</strong></div>
          <div className="receipt-row"><span>Due date</span><span>{String(installment.dueDate).slice(0, 10)}</span></div>
          <div className="receipt-row"><span>Status</span><span>{installment.status.replaceAll('_', ' ').toLowerCase()}</span></div>
        </div>
        {error && <div className="status-banner error" role="alert">{error}</div>}
        {notice && <div className="status-banner success" role="status">{notice}</div>}
        <form onSubmit={submit}>
          <div className="field"><label htmlFor="installment-phone">Mobile number for payment</label>
            <input id="installment-phone" inputMode="tel" autoComplete="tel" required disabled={attemptStarted} value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="0551234567" />
          </div>
          <button className="pay-btn" disabled={paying || attemptStarted}>{paying ? 'Sending prompt…' : attemptStarted ? 'Payment started' : 'Pay installment'}</button>
        </form>
      </>}
    </section>
    <p className="link-row"><Link to="/credit-schedule">View your credit schedule</Link></p>
  </div>
}
