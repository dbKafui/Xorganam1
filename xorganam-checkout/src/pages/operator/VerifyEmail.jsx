import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { operatorAuth } from '../../api/client'

export default function VerifyEmail() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  const started = useRef(false)
  const [state, setState] = useState(token ? 'checking' : 'invalid')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!token || started.current) return
    started.current = true
    window.history.replaceState(window.history.state, '', window.location.pathname)
    operatorAuth.verifyEmail(token)
      .then((result) => {
        setMessage(result.message || 'Email verified. You can now sign in.')
        setState('verified')
      })
      .catch((error) => {
        setMessage(error.message || 'This verification link is invalid or has expired.')
        setState('invalid')
      })
  }, [token])

  return (
    <div className="page">
      <div className="brand"><span className="mark">XORGANAM</span><span className="tag">Email verification</span></div>
      <section className="pay-card" aria-live="polite">
        {state === 'checking' && <><h1>Verifying your email</h1><p>Please wait while we confirm this one-time link.</p></>}
        {state === 'verified' && <>
          <div className="status-banner success" role="status"><span className="status-icon">✓</span><span>{message}</span></div>
          <Link className="pay-btn" to="/operator/login" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>Continue to sign in</Link>
        </>}
        {state === 'invalid' && <>
          <h1>Verification link unavailable</h1>
          <div className="status-banner error" role="alert"><span className="status-icon">!</span><span>{message || 'This link is missing, expired, or has already been used.'}</span></div>
          <Link className="secondary-btn" to="/operator/login" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>Back to sign in</Link>
        </>}
      </section>
    </div>
  )
}
