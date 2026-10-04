import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function Login() {
  const { login, setupMfa, completeMfa, user } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [challenge, setChallenge] = useState('')
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState('')

  useEffect(() => {
    if (user) navigate('/', { replace: true })
  }, [user, navigate])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await login(email, password)
      if (result.mfaEnrollmentRequired) {
        const setup = await setupMfa(result.challengeToken)
        setSecret(setup.secret)
      }
      setChallenge(result.challengeToken)
    } catch (err) {
      setError(err.message || 'Sign in failed.')
    } finally {
      setLoading(false)
    }
  }

  async function handleMfa(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try { await completeMfa(challenge, code); navigate('/', { replace: true }) }
    catch (err) { setError(err.message || 'Authenticator verification failed.') }
    finally { setLoading(false) }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-brand">
          XORGANAM
          <small>Backoffice — multi-tenant payment orchestration</small>
        </div>

        {challenge ? <form onSubmit={handleMfa} style={{ marginTop: 20 }}>
          <h2>Verify your authenticator</h2>
          <p>Use an authenticator app. Enter the six digit code to continue.</p>
          {secret && <div className="alert">Add this setup key to your authenticator app: <strong>{secret}</strong></div>}
          {error && <div className="alert alert-error">{error}</div>}
          <label htmlFor="mfa-code">Authenticator code</label>
          <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} />
          <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>{loading ? 'Verifying…' : 'Verify and continue'}</button>
        </form> : <form onSubmit={handleSubmit} style={{ marginTop: 20 }}>
          {error && <div className="alert alert-error">{error}</div>}

          <div className="field" style={{ marginBottom: 12 }}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </div>

          <div className="field" style={{ marginBottom: 18 }}>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>}
      </div>
    </div>
  )
}
