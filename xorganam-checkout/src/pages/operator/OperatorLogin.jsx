import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOperatorAuth } from '../../context/OperatorAuthContext'

export default function OperatorLogin() {
  const { login, user } = useOperatorAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (user) navigate('/operator/dashboard', { replace: true })
  }, [user, navigate])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email, password)
      navigate('/operator/dashboard', { replace: true })
    } catch (err) {
      setError(err.message || 'Sign in failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page">
      <div className="brand">
        <span className="mark">XORGANAM</span>
        <span className="tag">Operator login</span>
      </div>

      <div className="pay-card">
        <h1>Log in to your account</h1>

        <form onSubmit={handleSubmit}>
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
        </form>

        <div className="link-row">
          New operator? <Link to="/operator/register">Register your business</Link>
        </div>
      </div>
    </div>
  )
}
