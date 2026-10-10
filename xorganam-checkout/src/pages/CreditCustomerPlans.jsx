import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { creditCustomerApi, publicApi } from '../api/client'
import { clearIdempotencyKey, getOrCreateIdempotencyKey } from '../lib/idempotency'

import { formatCurrencyAmount } from '../../../shared/currency.js'
function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '')
  if (digits.startsWith('0') && digits.length === 10) return `233${digits.slice(1)}`
  if (digits.startsWith('233') && digits.length === 12) return digits
  if (digits.length === 9) return `233${digits}`
  return ''
}

function money(value) { return formatCurrencyAmount(value || 0, 'GHS') }

export default function CreditCustomerPlans() {
  const [phone, setPhone] = useState(creditCustomerApi.getPhone())
  const [code, setCode] = useState('')
  const [codeRequested, setCodeRequested] = useState(false)
  const [plans, setPlans] = useState([])
  const [loading, setLoading] = useState(creditCustomerApi.hasSession())
  const [busyInstallment, setBusyInstallment] = useState('')
  const [pendingInstallments, setPendingInstallments] = useState({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function loadPlans() {
    setLoading(true)
    try { setPlans(await creditCustomerApi.listPlans()) }
    catch (requestError) { creditCustomerApi.clearSession(); setError(requestError.message) }
    finally { setLoading(false) }
  }

  useEffect(() => {
    if (creditCustomerApi.hasSession()) loadPlans()
  }, [])

  async function requestCode(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    const normalized = normalizePhone(phone)
    if (!normalized) return setError('Enter a valid mobile number.')
    try {
      await publicApi.requestCreditCustomerCode(normalized)
      setPhone(normalized)
      setCodeRequested(true)
      setNotice('If a credit schedule matches this number, a verification code has been sent.')
    } catch (requestError) { setError(requestError.message) }
  }

  async function verifyCode(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    try {
      const session = await publicApi.verifyCreditCustomerCode(phone, code)
      creditCustomerApi.saveSession(session)
      setNotice('Phone number verified.')
      await loadPlans()
    } catch (requestError) { setError(requestError.message) }
  }

  async function pay(plan, installment) {
    setError('')
    setNotice('')
    setBusyInstallment(installment.id)
    try {
      const storageKey = `xorganam_credit_payment_key:${plan.id}:${installment.id}`
      const result = await creditCustomerApi.payInstallment(plan.id, installment.id, getOrCreateIdempotencyKey(storageKey))
      setNotice(result.message || 'Payment prompt sent. Approve it on your phone.')
      if (result.status === 'FAILED') clearIdempotencyKey(storageKey)
      else setPendingInstallments((current) => ({ ...current, [installment.id]: true }))
    } catch (requestError) { setError(requestError.message) }
    finally { setBusyInstallment('') }
  }

  function logout() {
    creditCustomerApi.clearSession()
    setPlans([])
    setCodeRequested(false)
    setCode('')
    setNotice('')
  }

  return <div className="page credit-customer-page">
    <div className="brand"><span className="mark">XORGANAM</span><span className="tag">Your credit schedule</span></div>
    <main className="credit-customer-content">
      <header className="portal-header"><div><h1>Credit plans</h1><p>Verify the mobile number on your plan to view its balance and installments.</p></div>
        {creditCustomerApi.hasSession() && <button className="secondary-btn" onClick={logout}>Sign out</button>}</header>
      {error && <div className="status-banner error" role="alert">{error}</div>}
      {notice && <div className="status-banner success" role="status">{notice}</div>}
      {!creditCustomerApi.hasSession() && !codeRequested && <form className="pay-card" onSubmit={requestCode}>
        <h2>Verify your phone number</h2>
        <div className="field"><label htmlFor="credit-phone">Mobile number</label><input id="credit-phone" inputMode="tel" autoComplete="tel" required value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="0551234567" /></div>
        <button className="pay-btn" disabled={loading}>Send verification code</button>
      </form>}
      {!creditCustomerApi.hasSession() && codeRequested && <form className="pay-card" onSubmit={verifyCode}>
        <h2>Enter your code</h2><p>We sent a six-digit code if a plan matches {phone}.</p>
        <div className="field"><label htmlFor="credit-code">Verification code</label><input id="credit-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value)} /></div>
        <button className="pay-btn" disabled={loading}>{loading ? 'Verifying…' : 'Verify and continue'}</button>
      </form>}
      {creditCustomerApi.hasSession() && (loading ? <div className="empty-state">Loading your plans…</div> : !plans.length ? <div className="empty-state">No credit plans were found for this verified number.</div> : plans.map((plan) => {
        const next = plan.installments.find((item) => ['PENDING', 'OVERDUE'].includes(item.status))
        return <section className="card credit-customer-plan" key={plan.id}>
          <div className="portal-header"><div><h2>{plan.merchant_name}</h2><p>{plan.status.replaceAll('_', ' ').toLowerCase()} · {plan.installment_frequency.toLowerCase()} installments</p></div></div>
          <div className="receipt">
            <div className="receipt-row"><span>Outstanding promised</span><strong>{money(plan.outstanding_promised)}</strong></div>
            <div className="receipt-row"><span>Actually collected</span><strong>{money(plan.actually_collected)}</strong></div>
          </div>
          <div className="credit-installments">
            {plan.installments.map((item) => <div className="kv-row" key={item.id}>
              <span>Installment {item.installment_number} · {String(item.due_date).slice(0, 10)} · {money(item.amount_due)}</span>
              <span className={`status-pill ${String(item.status).toLowerCase()}`}>{item.status.toLowerCase().replaceAll('_', ' ')}</span>
            </div>)}
          </div>
          {next && <button className="pay-btn" disabled={!!busyInstallment || pendingInstallments[next.id]} onClick={() => pay(plan, next)}>{busyInstallment === next.id ? 'Sending prompt…' : pendingInstallments[next.id] ? 'Payment started · check status' : `Pay installment ${next.installment_number} · ${money(next.amount_due)}`}</button>}
        </section>
      }))}
      <p className="link-row"><Link to="/">Return to checkout</Link></p>
    </main>
  </div>
}
