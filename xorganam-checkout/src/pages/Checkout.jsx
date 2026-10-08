import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { publicApi } from '../api/client'
import { clearIdempotencyKey, getOrCreateIdempotencyKey } from '../lib/idempotency'
import { classifyPaymentStatus } from '../lib/statusOutcome'
import PaymentStatusDetails from '../components/PaymentStatusDetails.jsx'

const MSISDN_PATTERN = /^(?:0[0-9]{9}|233[0-9]{9})$/
const MAX_PAYMENT_AMOUNT = 1_000_000

function normalizeMsisdn(rawMsisdn) {
  if (!rawMsisdn) return ''
  const digits = String(rawMsisdn).trim().replace(/\D/g, '')
  if (digits.startsWith('0') && digits.length === 10) return `233${digits.slice(1)}`
  if (digits.startsWith('233') && digits.length === 12) return digits
  if (digits.startsWith('2330') && digits.length === 13) return `233${digits.slice(4)}`
  if (digits.length === 9) return `233${digits}`
  return digits
}

function isValidCardNumber(value) {
  const digits = String(value).replace(/\D/g, '')
  if (digits.length < 12 || digits.length > 19) return false
  let sum = 0
  let parity = digits.length % 2
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[index])
    if (index % 2 === parity) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return sum % 10 === 0
}

function isValidExpiry(month, year) {
  const monthNumber = Number(month)
  const yearNumber = Number(String(year).slice(-2))
  if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12 || !Number.isInteger(yearNumber)) return false
  const expiryDate = new Date(2000 + yearNumber, monthNumber, 0, 23, 59, 59)
  return expiryDate >= new Date()
}

function getMerchantIdFromUrl() {
  const params = new URLSearchParams(window.location.search)
  return params.get('merchant') || params.get('merchantId') || ''
}

export default function Checkout() {
  const merchantId = getMerchantIdFromUrl()
  const idempotencyStorageKey = `xorganam_collection_key:${merchantId}`

  const [merchant, setMerchant] = useState(null)
  const [merchantError, setMerchantError] = useState('')

  const [amount, setAmount] = useState('')
  const [msisdn, setMsisdn] = useState('')
  const [collectionMethod, setCollectionMethod] = useState('MOMO')
  const [card, setCard] = useState({ number: '', name: '', month: '', year: '', cvv: '' })
  const [redirectHtml, setRedirectHtml] = useState('')
  const [formError, setFormError] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  // idle -> submitting -> success | failed
  const [stage, setStage] = useState('idle')
  const [reference, setReference] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [paymentGatewayStatus, setPaymentGatewayStatus] = useState('')
  const pollingTimerRef = useRef(null)
  const idempotencyKeyRef = useRef(sessionStorage.getItem(idempotencyStorageKey))

  useEffect(() => {
    if (!merchantId) {
      setMerchantError('No merchant specified. Add ?merchant=<merchant-id> to the link.')
      return
    }
    publicApi
      .getMerchant(merchantId)
      .then(setMerchant)
      .catch((err) => setMerchantError(err.message))
  }, [merchantId])

  async function handleSubmit(e) {
    e.preventDefault()
    setFormError('')

    if (!merchant?.acceptingPayments) {
      setFormError('This merchant is not currently accepting payments.')
      return
    }

    const numericAmount = Number(amount)
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setFormError('Enter an amount greater than 0.')
      return
    }
    if (numericAmount > MAX_PAYMENT_AMOUNT) {
      setFormError(`Enter an amount no greater than GHS ${MAX_PAYMENT_AMOUNT.toLocaleString()}.`)
      return
    }
    if (collectionMethod === 'MOMO' && !MSISDN_PATTERN.test(msisdn)) {
      setFormError('Enter a valid mobile number in local or international format, e.g. 0551234567 or 233551234567.')
      return
    }
    if (collectionMethod === 'CARD') {
      if (!isValidCardNumber(card.number)) {
        setFormError('Enter a valid card number with 12 to 19 digits.')
        return
      }
      if (card.name.trim().length < 2) {
        setFormError('Enter the name shown on the card.')
        return
      }
      if (!isValidExpiry(card.month, card.year)) {
        setFormError('Enter a valid future expiry date.')
        return
      }
      if (!/^\d{3,4}$/.test(card.cvv)) {
        setFormError('Enter a valid 3 or 4 digit card security code.')
        return
      }
    }

    setStage('submitting')
    try {
      const normalizedMsisdn = collectionMethod === 'MOMO' ? normalizeMsisdn(msisdn) : ''
      if (collectionMethod === 'MOMO' && (!normalizedMsisdn || normalizedMsisdn.length !== 12)) {
        setFormError('Enter a valid mobile number in local or international format.')
        setStage('idle')
        return
      }

      if (!idempotencyKeyRef.current) idempotencyKeyRef.current = getOrCreateIdempotencyKey(idempotencyStorageKey)
      const result = await publicApi.collect({ merchantId, amount: numericAmount, msisdn: normalizedMsisdn || undefined, collectionMethod, ...(collectionMethod === 'CARD' ? { cardNumber: card.number, cardholderName: card.name, expiryDateMonth: Number(card.month), expiryDateYear: card.year.slice(-2), cvv: card.cvv } : {}) }, idempotencyKeyRef.current)
      setReference(result.reference)
      setPaymentGatewayStatus(result.paymentGatewayStatus || result.status || '')
      
      if (result.status === 'FAILED') {
        idempotencyKeyRef.current = null
        clearIdempotencyKey(idempotencyStorageKey)
        setStatusMessage(result.message || `Payment could not be started: ${result.failureReason || 'Unknown error'}`)
        setStage('failed')
      } else if (String(result.paymentGatewayStatus).toUpperCase() === 'AUTHENTICATION_IN_PROGRESS' && result.redirectHtml) {
        try { setRedirectHtml(decodeURIComponent(escape(atob(result.redirectHtml)))) } catch { setRedirectHtml(atob(result.redirectHtml)) }
        setStage('auth')
      } else {
        setStatusMessage(result.message || 'Payment prompt sent. Waiting for approval on your phone…')
        setStage('pending')
      }
    } catch (err) {
      setFormError(err.message)
      if (err.status >= 400 && err.status < 500 && err.status !== 409) {
        idempotencyKeyRef.current = null
        clearIdempotencyKey(idempotencyStorageKey)
      }
      setStage('idle')
    }
  }

  useEffect(() => {
    if (!reference || stage !== 'pending') return

    let cancelled = false
    let attempts = 0
    const MAX_ATTEMPTS = 20
    const POLL_INTERVAL = 3000

    async function pollStatus() {
      if (cancelled) return

      try {
        const result = await publicApi.getStatus(reference)
        if (cancelled) return

        const status = String(result.status || '').toUpperCase()
        const outcome = classifyPaymentStatus({ status, failureReason: result.failureReason })
        setPaymentGatewayStatus(result.paymentGatewayStatus || result.status || '')

        if (outcome.state === 'pending') {
          attempts += 1
          const secondsLeft = Math.max(0, (MAX_ATTEMPTS - attempts) * 3)
          if (attempts >= MAX_ATTEMPTS) {
            setStatusMessage(`Payment is processing. Check back in a few minutes, or refresh the page to check status.`)
            return
          }
          setStatusMessage(`Payment prompt sent. Waiting for approval on your phone. Checking again in ${secondsLeft}s…`)
          pollingTimerRef.current = window.setTimeout(pollStatus, POLL_INTERVAL)
          return
        }

        if (outcome.state === 'success') {
          setStatusMessage(outcome.message)
          setStage('success')
          return
        }

        if (outcome.state === 'partial') {
          setStatusMessage(`${outcome.message} Please contact support or use the reconciliation page before retrying.`)
          setStage('failed')
          return
        }

        if (outcome.state === 'manual-reconciliation') {
          setStatusMessage(`${outcome.title}: ${outcome.message}`)
          setStage('failed')
          return
        }

        setStatusMessage(outcome.message)
        setStage('failed')
      } catch (err) {
        if (cancelled) return
        setStatusMessage(err.message || 'Unable to check payment status.')
        attempts += 1
        if (attempts < MAX_ATTEMPTS) {
          pollingTimerRef.current = window.setTimeout(pollStatus, POLL_INTERVAL)
        } else {
          setStage('failed')
        }
      }
    }

    pollStatus()

    return () => {
      cancelled = true
      if (pollingTimerRef.current) {
        clearTimeout(pollingTimerRef.current)
      }
    }
  }, [reference, stage])

  function reset() {
    setStage('idle')
    setAmount('')
    setMsisdn('')
    setReference('')
    setStatusMessage('')
    setPaymentGatewayStatus('')
    idempotencyKeyRef.current = null
    clearIdempotencyKey(idempotencyStorageKey)
  }

  return (
    <div className="page">
      <div className="brand">
        <span className="mark">XORGANAM</span>
        <span className="tag">Secure payment</span>
      </div>

      <div className="pay-card">
        {merchantError && (
          <div className="status-banner error">
            <span className="status-icon">⚠</span>
            <span>{merchantError}</span>
          </div>
        )}

        {!merchantError && !merchant && <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading merchant details…</p>}

        {merchant && !merchant.acceptingPayments && (
          <div className="status-banner error">
            <span className="status-icon">⚠</span>
            <span>{merchant.displayName} isn't currently accepting payments. Please try again later.</span>
          </div>
        )}

        {merchant?.acceptingPayments && stage === 'idle' && (
          <>
            <div className="merchant">Pay</div>
            <h1>{merchant.displayName}</h1>

            <form onSubmit={handleSubmit}>
              {formError && (
                <div className="status-banner error">
                  <span className="status-icon">⚠</span>
                  <span>{formError}</span>
                </div>
              )}

              <div className="field"><label htmlFor="collection-method">Payment method</label><select id="collection-method" value={collectionMethod} onChange={(e) => setCollectionMethod(e.target.value)}><option value="MOMO">Mobile Money</option><option value="CARD">Visa / Mastercard</option></select></div>
              <div className="field">
                <label htmlFor="amount">Amount</label>
                <div className="prefix-input">
                  <span>GHS</span>
                  <input
                    id="amount"
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
              </div>

              {collectionMethod === 'CARD' && <div className="two-col">
                <div className="field"><label htmlFor="card-number">Card number</label><input id="card-number" required minLength="12" maxLength="19" autoComplete="cc-number" inputMode="numeric" value={card.number} onChange={(e) => setCard((v) => ({ ...v, number: e.target.value.replace(/\D/g, '').slice(0, 19) }))} /></div>
                <div className="field"><label htmlFor="card-name">Cardholder name</label><input id="card-name" required minLength="2" maxLength="128" autoComplete="cc-name" value={card.name} onChange={(e) => setCard((v) => ({ ...v, name: e.target.value }))} /></div>
                <div className="field"><label htmlFor="card-month">Expiry month</label><input id="card-month" required type="number" min="1" max="12" autoComplete="cc-exp-month" value={card.month} onChange={(e) => setCard((v) => ({ ...v, month: e.target.value.slice(0, 2) }))} /></div>
                <div className="field"><label htmlFor="card-year">Expiry year</label><input id="card-year" required inputMode="numeric" min="2000" max="2099" autoComplete="cc-exp-year" placeholder="2030" value={card.year} onChange={(e) => setCard((v) => ({ ...v, year: e.target.value.replace(/\D/g, '').slice(0, 4) }))} /></div>
                <div className="field"><label htmlFor="card-cvv">CVV</label><div className="password-field"><input id="card-cvv" required minLength="3" maxLength="4" type={showPassword ? 'text' : 'password'} inputMode="numeric" autoComplete="cc-csc" value={card.cvv} onChange={(e) => setCard((v) => ({ ...v, cvv: e.target.value.replace(/\D/g, '').slice(0, 4) }))} /><button type="button" className="password-toggle" aria-label={showPassword ? 'Hide CVV' : 'Show CVV'} aria-pressed={showPassword} onClick={() => setShowPassword((current) => !current)}>{showPassword ? 'Hide' : 'Show'}</button></div></div>
              </div>}
              {collectionMethod === 'MOMO' && <div className="field">
                <label htmlFor="msisdn">Mobile money number</label>
                <input
                  id="msisdn"
                  type="tel"
                  inputMode="numeric"
                  placeholder="0551234567 or 233551234567"
                  value={msisdn}
                  onChange={(e) => setMsisdn(e.target.value)}
                />
              </div>}

              {collectionMethod === 'MOMO' && <p style={{ fontSize: 12, color: 'var(--muted)', margin: '8px 0' }}>Payment via {merchant?.networkProvider || 'mobile money'}</p>}

              <button type="submit" className="pay-btn" disabled={stage === 'submitting'}>{stage === 'submitting' ? 'Starting payment…' : 'Pay now'}</button>
            </form>
          </>
        )}

        {stage === 'auth' && <section className="payment-progress"><div className="payment-stepper" aria-label="Payment progress"><span className="complete">1</span><i /><span className="active">2</span><i /><span>3</span></div><h2>Verify card payment</h2><p>Complete the secure card verification shown below. Your payment details are not stored by XORGANAM.</p><iframe title="Card verification" sandbox="allow-forms allow-scripts allow-top-navigation-by-user-activation" srcDoc={redirectHtml} style={{ width: '100%', minHeight: 520, border: 0 }} /><button className="secondary-btn" onClick={() => setStage('pending')}>I completed verification</button></section>}

        {stage === 'submitting' && (
          <div className="status-banner pending" role="status" aria-live="polite">
            <span className="spinner" />
            <span><strong>Starting your payment…</strong><small>Do not close this page while the payment request is being sent.</small></span>
          </div>
        )}

        {stage === 'pending' && (
          <>
            <div className="payment-stepper" aria-label="Payment progress"><span className="complete">1</span><i /><span className="active">2</span><i /><span>3</span></div>
            <div className="status-banner pending" role="status" aria-live="polite">
              <span className="spinner" />
              <span><strong>Payment pending</strong><small>{statusMessage || 'Payment prompt sent. Waiting for approval on your phone…'}</small></span>
            </div>
            <div className="receipt">
              <div className="receipt-row"><span>Amount</span><span className="mono">GHS {Number(amount).toFixed(2)}</span></div>
              <div className="receipt-row"><span>Reference</span><span className="mono">{reference}</span></div>
              <div className="receipt-row"><span>Gateway status</span><span className="mono">{paymentGatewayStatus || 'PENDING'}</span></div>
            </div>
            <p className="payment-security-note"><span>✓</span> For your security, do not share the payment reference or card details with anyone.</p>
            <p className="payment-security-note">Do not start another payment while this one is pending. Wait for the status to update before retrying.</p>
          </>
        )}

        {stage === 'success' && (
          <>
            <div className="payment-stepper" aria-label="Payment progress"><span className="complete">1</span><i /><span className="complete">2</span><i /><span className="complete">3</span></div>
            <div className="status-banner success" role="status" aria-live="polite">
              <span className="status-icon">✓</span>
              <span><strong>Payment completed</strong><small>{statusMessage || 'Your payment was completed successfully.'}</small></span>
            </div>
            <div className="receipt">
              <div className="receipt-row"><span>Amount</span><span className="mono">GHS {Number(amount).toFixed(2)}</span></div>
              <div className="receipt-row"><span>Reference</span><span className="mono">{reference}</span></div>
              <div className="receipt-row"><span>Gateway status</span><span className="mono">{paymentGatewayStatus || 'SUCCESSFUL'}</span></div>
            </div>
            <button className="secondary-btn" onClick={reset}>Make another payment</button>
          </>
        )}

        {stage === 'failed' && (
          <>
            <div className="payment-stepper" aria-label="Payment progress"><span className="complete">1</span><i /><span className="error-step">2</span><i /><span>3</span></div>
            <PaymentStatusDetails status={paymentGatewayStatus || 'FAILED'} failureReason={statusMessage} />
            {reference && (
              <div className="receipt">
                <div className="receipt-row"><span>Reference</span><span className="mono">{reference}</span></div>
              </div>
            )}
            <button className="secondary-btn" onClick={reset}>Try again</button>
          </>
        )}
      </div>

      <p className="footer-note">
        Powered by XORGANAM. When you tap "Pay now" you'll get a real payment prompt on your
        phone from your mobile network — approve it there to complete the payment. This page
        confirms the prompt was sent; it can't confirm you approved it on your phone.
      </p>

      <p className="link-row" style={{ marginTop: 6 }}>
        Are you a business? <Link to="/operator/register">Accept payments with XORGANAM</Link>
      </p>
      <p className="link-row" style={{ marginTop: 8 }}><Link to="/credit-schedule">View a credit schedule</Link></p>
    </div>
  )
}
