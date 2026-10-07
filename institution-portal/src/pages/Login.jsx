import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useInstitutionAuth } from '../context/InstitutionAuthContext.jsx'

export default function Login() {
  const { login, setupMfa, completeMfa, staff } = useInstitutionAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [challenge, setChallenge] = useState('')
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState('')

  useEffect(() => {
    if (staff) navigate('/dashboard', { replace: true })
  }, [staff, navigate])

  if (staff) return <Navigate to="/dashboard" replace />

  async function submit(event) {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const result = await login(email.trim(), password)
      if (result.mfaEnrollmentRequired) setSecret((await setupMfa(result.challengeToken)).secret)
      setChallenge(result.challengeToken)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function submitMfa(event) {
    event.preventDefault(); setError(''); setSubmitting(true)
    try { await completeMfa(challenge, code); navigate('/dashboard', { replace: true }) }
    catch (requestError) { setError(requestError.message) }
    finally { setSubmitting(false) }
  }

  return (
    <main className="login-screen">
      <section className="login-aside">
        <div className="login-brand"><span className="brand-symbol">X</span><span>XORGANAM<small>INSTITUTION PORTAL</small></span></div>
        <div className="login-message">
          <div className="eyebrow">TRUST, MADE VISIBLE</div>
          <h1>One clear view of every relationship.</h1>
          <p>Review institution links, monitor settlement activity, and coordinate your team from a secure workspace.</p>
          <div className="login-stats"><span><strong>01</strong> Verify membership</span><span><strong>02</strong> Track settlement</span><span><strong>03</strong> Resolve disputes</span></div>
        </div>
        <div className="login-aside-footer">Institution operations workspace <span>GHANA · XORGANAM</span></div>
      </section>
      <section className="login-main">
        <div className="login-card">
          <div className="eyebrow">WELCOME BACK</div>
          <h2>Sign in to your institution</h2>
          <p className="subtle">Use your institution staff account to continue.</p>
          {error && <div className="notice notice-error" role="alert"><strong>Sign in failed</strong><span>{error}</span></div>}
          {challenge ? <form onSubmit={submitMfa}>
            <p className="subtle">Complete authenticator verification to continue.</p>
            {secret && <div className="notice"><strong>Authenticator setup key</strong><span>{secret}</span></div>}
            {error && <div className="notice notice-error" role="alert"><strong>Verification failed</strong><span>{error}</span></div>}
            <label className="form-field"><span>Six digit authenticator code</span><input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} /></label>
            <button className="button button-primary button-wide" disabled={submitting}>{submitting ? 'Verifying...' : 'Verify and continue'} <span>→</span></button>
          </form> : <form onSubmit={submit}>
            <label className="form-field"><span>Email address</span><input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@institution.com" /></label>
            <label className="form-field"><span>Password</span><input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" /></label>
            <button className="button button-primary button-wide" disabled={submitting}>{submitting ? 'Signing in...' : 'Sign in securely'} <span>→</span></button>
          </form>}
          <p className="login-register-link">New institution? <a href="/register">Apply to onboard</a></p>
          <div className="login-security"><span className="secure-icon">●</span> Your institution session is separate from tenant and platform accounts.</div>
        </div>
      </section>
    </main>
  )
}
