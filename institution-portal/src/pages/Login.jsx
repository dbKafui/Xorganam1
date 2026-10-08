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
  const [recoveryMode, setRecoveryMode] = useState(false)
  const [recoveryCodes, setRecoveryCodes] = useState([])

  useEffect(() => {
    if (staff && !challenge && recoveryCodes.length === 0) navigate('/dashboard', { replace: true })
  }, [staff, challenge, recoveryCodes.length, navigate])

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
    try {
      const result = await completeMfa(challenge, recoveryMode ? { recoveryCode: code } : { code })
      if (result.recoveryCodes?.length) setRecoveryCodes(result.recoveryCodes)
      else navigate('/dashboard', { replace: true })
    }
    catch (requestError) { setError(requestError.message) }
    finally { setSubmitting(false) }
  }

  function finishRecoveryCodeSetup() {
    navigate('/dashboard', { replace: true })
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
          {recoveryCodes.length > 0 ? <section>
            <h3>Save your recovery codes</h3>
            <p className="subtle">Each code works once. Store them somewhere private; they will not be shown again.</p>
            <ol className="mfa-recovery-codes">{recoveryCodes.map((recoveryCode) => <li className="mono" key={recoveryCode}>{recoveryCode}</li>)}</ol>
            <button type="button" className="button button-primary button-wide" onClick={finishRecoveryCodeSetup}>I have saved these codes</button>
          </section> : challenge ? <form onSubmit={submitMfa}>
            <p className="subtle">Complete authenticator verification to continue.</p>
            {secret && <div className="notice"><strong>Authenticator setup key</strong><span>{secret}</span></div>}
            {error && <div className="notice notice-error" role="alert"><strong>Verification failed</strong><span>{error}</span></div>}
            <label className="form-field"><span>{recoveryMode ? 'Recovery code' : 'Six digit authenticator code'}</span><input required inputMode={recoveryMode ? 'text' : 'numeric'} autoComplete="one-time-code" pattern={recoveryMode ? undefined : '[0-9]{6}'} maxLength={recoveryMode ? 29 : 6} value={code} onChange={(event) => setCode(recoveryMode ? event.target.value.toUpperCase() : event.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
            <button className="button button-primary button-wide" disabled={submitting}>{submitting ? 'Verifying...' : 'Verify and continue'} <span>→</span></button>
            {!secret && <button type="button" className="button button-secondary button-wide" disabled={submitting} onClick={() => { setRecoveryMode((current) => !current); setCode(''); setError('') }}>{recoveryMode ? 'Use authenticator app instead' : 'Use a recovery code'}</button>}
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
