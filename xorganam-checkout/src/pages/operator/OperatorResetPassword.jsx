import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { operatorAuth } from '../../api/client'

export default function OperatorResetPassword() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (token) window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [token])

  async function requestLink(event) {
    event.preventDefault()
    setLoading(true)
    setError('')
    setMessage('')
    try {
      const result = await operatorAuth.requestPasswordReset(email)
      setMessage(result.message || 'If the account exists, a password setup link has been sent.')
    } catch (requestError) {
      setError(requestError.message || 'Unable to request a password setup link.')
    } finally {
      setLoading(false)
    }
  }

  async function setNewPassword(event) {
    event.preventDefault()
    setError('')
    setMessage('')
    if (password !== confirmPassword) {
      setError('The passwords do not match.')
      return
    }
    setLoading(true)
    try {
      await operatorAuth.confirmPasswordReset(token, password)
      setMessage('Password set. You can now sign in.')
      setPassword('')
      setConfirmPassword('')
    } catch (requestError) {
      setError(requestError.message || 'Unable to set the password.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page">
      <div className="brand"><span className="mark">XORGANAM</span><span className="tag">{token ? 'Set password' : 'Password recovery'}</span></div>
      <section className="pay-card" aria-live="polite">
        <h1>{token ? 'Choose a password' : 'Reset your password'}</h1>
        {token ? <form onSubmit={setNewPassword}>
          <div className="field"><label htmlFor="operator-new-password">New password</label><input id="operator-new-password" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} /></div>
          <div className="field"><label htmlFor="operator-confirm-password">Confirm password</label><input id="operator-confirm-password" type="password" autoComplete="new-password" minLength={12} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></div>
          <button className="pay-btn" type="submit" disabled={loading}>{loading ? 'Saving…' : 'Set password'}</button>
        </form> : <form onSubmit={requestLink}>
          <p>Enter your account email and we’ll send a one-time password link if the account is eligible.</p>
          <div className="field"><label htmlFor="operator-reset-email">Email</label><input id="operator-reset-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></div>
          <button className="pay-btn" type="submit" disabled={loading}>{loading ? 'Sending…' : 'Send password link'}</button>
        </form>}
        {message && <div className="status-banner success" role="status">{message}</div>}
        {error && <div className="status-banner error" role="alert">{error}</div>}
        <Link className="secondary-btn" to="/operator/login" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>Return to sign in</Link>
      </section>
    </div>
  )
}