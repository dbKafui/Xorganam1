import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useOperatorAuth } from '../../context/OperatorAuthContext'

export default function OperatorLogin() {
  const { login, setupMfa, completeMfa, user } = useOperatorAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [challenge, setChallenge] = useState('')
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState('')

  useEffect(() => {
    if (user) navigate('/operator/dashboard', { replace: true })
  }, [user, navigate])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await login(email, password)
      if (result.mfaEnrollmentRequired) setSecret((await setupMfa(result.challengeToken)).secret)
      setChallenge(result.challengeToken)
    } catch (err) {
      setError(err.message || 'Sign in failed.')
    } finally {
      setLoading(false)
    }
  }

  async function submitMfa(e) {
    e.preventDefault(); setError(''); setLoading(true)
    try { await completeMfa(challenge, code); navigate('/operator/dashboard', { replace: true }) }
    catch (err) { setError(err.message || 'Authenticator verification failed.') }
    finally { setLoading(false) }
  }

  return (
    <div className="page">
      <div className="brand">
        <span className="mark">XORGANAM</span>
        <span className="tag">Operator login</span>
      </div>

      <div className="pay-card">
        <h1>Log in to your account</h1>

        {challenge ? <form onSubmit={submitMfa}>
          <p>Complete authenticator verification to continue.</p>
          {secret && <p><strong>Authenticator setup key:</strong> {secret}</p>}
          {error && <div className="status-banner error"><span>{error}</span></div>}
          <div className="field"><label>Six digit code</label><input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} /></div>
          <button type="submit" className="pay-btn" disabled={loading}>{loading ? 'Verifying…' : 'Verify and continue'}</button>
        </form> : <form onSubmit={handleSubmit}>
          {location.state?.registered && <div className="status-banner">Registration complete. Sign in to enroll MFA.</div>}
          {error && (
            <div className="status-banner error">
              <span className="status-icon">⚠</span>
              <span>{error}</span>
            </div>
          )}

          <div className="field">
            <label>Email</label>
            <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>

          <div className="field">
            <label>Password</label>
            <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>

          <button type="submit" className="pay-btn" disabled={loading}>
            {loading ? 'Signing in…' : 'Log in'}
          </button>
        </form>}

        <div className="link-row">
          New operator? <Link to="/operator/register">Register your business</Link>
        </div>
      </div>
    </div>
  )
}
