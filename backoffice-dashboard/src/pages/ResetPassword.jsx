import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { authApi } from '../api/auth'

export default function ResetPassword() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  const [email, setEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleRequest(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    setMessage('')
    try {
      const result = await authApi.requestPasswordReset(email)
      setMessage(result.message || 'Reset request received.')
    } catch (err) {
      setError(err.message || 'Unable to request a password reset.')
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirm(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    setMessage('')
    try {
      await authApi.confirmPasswordReset(token, newPassword)
      setMessage('Password updated. You can now sign in.')
    } catch (err) {
      setError(err.message || 'Unable to reset the password.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-brand">XORGANAM</div>
        <h2>Password recovery</h2>
        <p>Enter your email to request a reset link. The link expires in 30 minutes.</p>
        <form onSubmit={handleRequest}>
          <label htmlFor="reset-email">Email</label>
          <input id="reset-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn btn-primary" type="submit" disabled={loading}>{loading ? 'Sending…' : 'Send reset link'}</button>
        </form>
        {token && (
          <form onSubmit={handleConfirm} style={{ marginTop: 24 }}>
            <label htmlFor="new-password">New password</label>
            <input id="new-password" type="password" minLength={12} required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            <button className="btn btn-primary" type="submit" disabled={loading}>{loading ? 'Updating…' : 'Update password'}</button>
          </form>
        )}
        {message && <div className="alert" style={{ marginTop: 16 }}>{message}</div>}
        {error && <div className="alert alert-error" style={{ marginTop: 16 }}>{error}</div>}
        <Link to="/login" style={{ display: 'block', marginTop: 20 }}>Return to sign in</Link>
      </div>
    </div>
  )
}
