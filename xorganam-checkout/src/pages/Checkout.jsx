import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { publicApi } from '../api/client'

const MSISDN_PATTERN = /^(?:0[0-9]{9}|233[0-9]{9})$/

function normalizeMsisdn(rawMsisdn) {
  if (!rawMsisdn) return ''
  const digits = String(rawMsisdn).trim().replace(/\D/g, '')
  if (digits.startsWith('0') && digits.length === 10) return `233${digits.slice(1)}`
  if (digits.startsWith('233') && digits.length === 12) return digits
  if (digits.startsWith('2330') && digits.length === 13) return `233${digits.slice(4)}`
  if (digits.length === 9) return `233${digits}`
  return digits
}

function getMerchantIdFromUrl() {
  const params = new URLSearchParams(window.location.search)
  return params.get('merchant') || params.get('merchantId') || ''
}

export default function Checkout() {
  const merchantId = getMerchantIdFromUrl()

  const [merchant, setMerchant] = useState(null)
  const [merchantError, setMerchantError] = useState('')

  const [amount, setAmount] = useState('')
  const [msisdn, setMsisdn] = useState('')
  const [formError, setFormError] = useState('')

  // idle -> submitting -> success | failed
  const [stage, setStage] = useState('idle')
  const [reference, setReference] = useState('')
  const [statusMessage, setStatusMessage] = useState('')

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

    const numericAmount = Number(amount)
    if (!numericAmount || numericAmount <= 0) {
      setFormError('Enter an amount greater than 0.')
      return
    }
    if (!MSISDN_PATTERN.test(msisdn)) {
      setFormError('Enter a valid mobile number in local or international format, e.g. 0551234567 or 233551234567.')
      return
    }

    setStage('submitting')
    try {
      const normalizedMsisdn = normalizeMsisdn(msisdn)
      if (!normalizedMsisdn || normalizedMsisdn.length !== 12) {
        setFormError('Enter a valid mobile number in local or international format.')
        setStage('idle')
        return
      }

      // This calls Eganow's Collection endpoint, which sends the real payment prompt
      // to the customer's phone via their network. We don't build or simulate that
      // prompt ourselves - this page only starts it and shows what we were told back.
      const result = await publicApi.collect({ merchantId, amount: numericAmount, msisdn: normalizedMsisdn })
      setReference(result.reference)
      setStatusMessage(result.message)
      setStage(result.status === 'FAILED' ? 'failed' : 'success')
    } catch (err) {
      setFormError(err.message)
      setStage('idle')
    }
  }

  function reset() {
    setStage('idle')
    setAmount('')
    setMsisdn('')
    setReference('')
    setStatusMessage('')
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
                    autoFocus
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="msisdn">Mobile money number</label>
                <input
                  id="msisdn"
                  type="tel"
                  inputMode="numeric"
                  placeholder="0551234567 or 233551234567"
                  value={msisdn}
                  onChange={(e) => setMsisdn(e.target.value)}
                />
              </div>

              <button type="submit" className="pay-btn">Pay now</button>
            </form>
          </>
        )}

        {stage === 'submitting' && (
          <div className="status-banner pending">
            <span className="spinner" />
            <span>Starting your payment…</span>
          </div>
        )}

        {stage === 'success' && (
          <>
            <div className="status-banner success">
              <span className="status-icon">✓</span>
              <span>{statusMessage || 'Payment started — check your phone to approve the prompt.'}</span>
            </div>
            <div className="receipt">
              <div className="receipt-row"><span>Amount</span><span className="mono">GHS {Number(amount).toFixed(2)}</span></div>
              <div className="receipt-row"><span>Reference</span><span className="mono">{reference}</span></div>
            </div>
            <button className="secondary-btn" onClick={reset}>Make another payment</button>
          </>
        )}

        {stage === 'failed' && (
          <>
            <div className="status-banner error">
              <span className="status-icon">⚠</span>
              <span>{statusMessage || 'Payment could not be started.'}</span>
            </div>
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
    </div>
  )
}
