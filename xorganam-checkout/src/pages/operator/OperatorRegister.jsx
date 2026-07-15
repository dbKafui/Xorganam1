import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOperatorAuth } from '../../context/OperatorAuthContext'

const initialForm = {
  companyName: '',
  contactPhone: '',
  contactEmail: '',
  firstName: '',
  lastName: '',
  email: '',
  password: ''
}

export default function OperatorRegister() {
  const { register } = useOperatorAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState(initialForm)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  function set(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      await register(form)
      navigate('/operator/dashboard', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <div className="brand">
        <span className="mark">XORGANAM</span>
        <span className="tag">Register your business</span>
      </div>

      <div className="pay-card" style={{ width: 440 }}>
        <h1>Create your operator account</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: -10, marginBottom: 18 }}>
          You'll be logged in immediately. Add your merchants (market women) and submit KYC once
          you're in — payments stay disabled until an admin reviews your documents.
        </p>

        <form onSubmit={handleSubmit}>
          {error && (
            <div className="status-banner error">
              <span className="status-icon">⚠</span>
              <span>{error}</span>
            </div>
          )}

          <div className="field">
            <label>Business name</label>
            <input required value={form.companyName} onChange={set('companyName')} />
          </div>

          <div className="two-col">
            <div className="field">
              <label>Business phone</label>
              <input required value={form.contactPhone} onChange={set('contactPhone')} placeholder="0551234567" />
            </div>
            <div className="field">
              <label>Business email</label>
              <input required type="email" value={form.contactEmail} onChange={set('contactEmail')} />
            </div>
          </div>

          <div className="two-col">
            <div className="field">
              <label>Your first name</label>
              <input required value={form.firstName} onChange={set('firstName')} />
            </div>
            <div className="field">
              <label>Your last name</label>
              <input required value={form.lastName} onChange={set('lastName')} />
            </div>
          </div>

          <div className="field">
            <label>Login email</label>
            <input required type="email" value={form.email} onChange={set('email')} />
          </div>

          <div className="field">
            <label>Password</label>
            <input required type="password" minLength={10} value={form.password} onChange={set('password')} />
          </div>

          <button type="submit" className="pay-btn" disabled={saving}>
            {saving ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <div className="link-row">
          Already registered? <Link to="/operator/login">Log in</Link>
        </div>
      </div>
    </div>
  )
}
