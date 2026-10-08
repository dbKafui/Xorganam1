import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useOperatorAuth } from '../../context/OperatorAuthContext'

export default function OperatorLogin() {
  const { login, setupMfa, completeMfa, requestEmailVerification, user } = useOperatorAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState(location.state?.email || '')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [challenge, setChallenge] = useState('')
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState('')
  const [recoveryMode, setRecoveryMode] = useState(false)
  const [recoveryCodes, setRecoveryCodes] = useState([])
  const [emailVerificationRequired, setEmailVerificationRequired] = useState(false)
  const [verificationNotice, setVerificationNotice] = useState('')

  useEffect(() => {
    if (user && !challenge && recoveryCodes.length === 0) navigate('/operator/dashboard', { replace: true })
  }, [user, challenge, recoveryCodes.length, navigate])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setVerificationNotice('')
    setEmailVerificationRequired(false)
    setLoading(true)
    try {
      const result = await login(email, password)
      if (result.mfaEnrollmentRequired) setSecret((await setupMfa(result.challengeToken)).secret)
      setChallenge(result.challengeToken)
    } catch (err) {
      setError(err.message || 'Sign in failed.')
      setEmailVerificationRequired(err.code === 'EMAIL_UNVERIFIED')
    } finally {
      setLoading(false)
    }
  }

  async function resendVerification() {
    setError('')
    setVerificationNotice('')
    setLoading(true)
    try {
      await requestEmailVerification(email)
      setVerificationNotice('If this account needs verification, instructions will be sent to its email address.')
    } catch (err) {
      setError(err.message || 'Unable to request a verification email.')
    } finally {
      setLoading(false)
    }
  }

  async function submitMfa(e) {
    e.preventDefault(); setError(''); setLoading(true)
    try {
      const result = await completeMfa(challenge, recoveryMode ? { recoveryCode: code } : { code })
      if (result.recoveryCodes?.length) setRecoveryCodes(result.recoveryCodes)
      else navigate('/operator/dashboard', { replace: true })
    }
    catch (err) { setError(err.message || 'Authenticator verification failed.') }
    finally { setLoading(false) }
  }

  function finishRecoveryCodeSetup() {
    navigate('/operator/dashboard', { replace: true })
  }

  return (
    <div className="page">
      <div className="brand">
        <span className="mark">XORGANAM</span>
        <span className="tag">Operator login</span>
      </div>

      <div className="pay-card">
        <h1>Log in to your account</h1>

        {recoveryCodes.length > 0 ? <section>
          <h2>Save your recovery codes</h2>
          <p>Each code works once. Store them somewhere private; they will not be shown again.</p>
          <ol className="mfa-recovery-codes">{recoveryCodes.map((recoveryCode) => <li className="mono" key={recoveryCode}>{recoveryCode}</li>)}</ol>
          <button type="button" className="pay-btn" onClick={finishRecoveryCodeSetup}>I have saved these codes</button>
        </section> : challenge ? <form onSubmit={submitMfa}>
          <p>Complete authenticator verification to continue.</p>
          {secret && <div className="status-banner success"><span className="status-icon">✓</span><span><strong>Authenticator setup key:</strong> {secret}</span></div>}
          {error && <div className="status-banner error" role="alert"><span className="status-icon">⚠</span><span>{error}</span></div>}
          <div className="field"><label htmlFor="operator-mfa-code">{recoveryMode ? 'Recovery code' : 'Six digit code'}</label><input id="operator-mfa-code" className={recoveryMode ? 'mono' : 'mfa-code-input'} required inputMode="text" autoComplete="one-time-code" maxLength={recoveryMode ? 29 : 6} value={code} onChange={(e) => setCode(recoveryMode ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, '').slice(0, 6))} /></div>
          <button type="submit" className="pay-btn" disabled={loading}>{loading ? 'Verifying…' : 'Verify and continue'}</button>
          {!secret && <button type="button" className="secondary-btn" disabled={loading} onClick={() => { setRecoveryMode((current) => !current); setCode(''); setError('') }}>{recoveryMode ? 'Use authenticator app instead' : 'Use a recovery code'}</button>}
        </form> : <form onSubmit={handleSubmit}>
          {location.state?.registered && <div className={`status-banner ${location.state.verificationEmailSent ? 'success' : 'error'}`} role="status"><span className="status-icon">{location.state.verificationEmailSent ? '✓' : '!'}</span><span>{location.state.verificationEmailSent ? 'Account created. Check your email to verify the address before signing in.' : 'Account created, but the verification email was not delivered. Contact support or request another email after delivery is restored.'}</span></div>}
          {verificationNotice && <div className="status-banner success" role="status"><span>{verificationNotice}</span></div>}
          {error && (
            <div className="status-banner error" role="alert">
              <span className="status-icon">⚠</span>
              <span>{error}</span>
            </div>
          )}

          <div className="field">
            <label>Email</label>
            <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>

          <div className="field">
            <label htmlFor="operator-password">Password</label>
            <div className="password-field">
              <input id="operator-password" required type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" className="password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword((current) => !current)}>{showPassword ? 'Hide' : 'Show'}</button>
            </div>
          </div>

          <button type="submit" className="pay-btn" disabled={loading}>
            {loading ? 'Signing in…' : 'Log in'}
          </button>
          {emailVerificationRequired && <button type="button" className="secondary-btn" disabled={loading || !email} onClick={resendVerification}>{loading ? 'Requesting…' : 'Resend verification email'}</button>}
        </form>}

        <div className="link-row">
          New operator? <Link to="/operator/register">Register your business</Link>
        </div>
      </div>
    </div>
  )
}
