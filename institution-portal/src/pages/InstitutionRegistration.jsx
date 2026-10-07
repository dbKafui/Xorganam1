import { useState } from 'react'
import { Link } from 'react-router-dom'
import { institutionAuth } from '../api/client.js'

const emptyApplication = {
  institutionName: '', institutionType: 'SAVINGS_AND_LOANS', settlementMsisdn: '',
  settlementAccountName: '', adminFirstName: '', adminLastName: '', adminEmail: '', adminPassword: ''
}

export default function InstitutionRegistration() {
  const [form, setForm] = useState(emptyApplication)
  const [application, setApplication] = useState(null)
  const [applicationId, setApplicationId] = useState('')
  const [trackingToken, setTrackingToken] = useState('')
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      const result = await institutionAuth.submitApplication(form)
      setApplication(result); setApplicationId(result.id); setTrackingToken(result.trackingToken)
      setStatus({ ...result, institutionName: form.institutionName })
      setNotice('Application submitted. Save the tracking code below to check its status later.')
      setForm(emptyApplication)
    } catch (requestError) { setError(requestError.message) }
    finally { setBusy(false) }
  }

  async function checkStatus(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      setStatus(await institutionAuth.checkApplicationStatus(applicationId.trim(), trackingToken.trim()))
      setNotice('Application status refreshed.')
    } catch (requestError) { setError(requestError.message) }
    finally { setBusy(false) }
  }

  return (
    <main className="login-screen">
      <section className="login-aside">
        <div className="login-brand"><span className="brand-symbol">X</span><span>XORGANAM<small>INSTITUTION ONBOARDING</small></span></div>
        <div className="login-message">
          <div className="eyebrow">A SEPARATE INSTITUTION WORKSPACE</div>
          <h1>Bring your institution onto XORGANAM.</h1>
          <p>Submit your institution details for review. Your administrator account activates after platform approval.</p>
          <div className="login-stats"><span><strong>01</strong> Submit details</span><span><strong>02</strong> Complete review</span><span><strong>03</strong> Sign in to your workspace</span></div>
        </div>
        <div className="login-aside-footer">Institution operations workspace <span>GHANA · XORGANAM</span></div>
      </section>

      <section className="login-main registration-main">
        <div className="registration-card">
          <div className="eyebrow">INSTITUTION REGISTRATION</div>
          <h2>Apply for an institution workspace</h2>
          <p className="subtle">XORGANAM reviews each application before creating the institution workspace. Use settlement details verified by your institution.</p>
          {error && <div className="notice notice-error" role="alert"><strong>Could not continue</strong><span>{error}</span></div>}
          {notice && <div className="notice notice-success" role="status"><strong>Update</strong><span>{notice}</span></div>}

          <form className="registration-form" onSubmit={submit}>
            <h3>Institution details</h3>
            <label className="form-field"><span>Institution name</span><input required minLength="2" maxLength="160" value={form.institutionName} onChange={(event) => setForm({ ...form, institutionName: event.target.value })} /></label>
            <label className="form-field"><span>Institution type</span><select value={form.institutionType} onChange={(event) => setForm({ ...form, institutionType: event.target.value })}><option value="SAVINGS_AND_LOANS">Savings and Loans</option><option value="CREDIT_UNION">Credit Union</option></select></label>
            <div className="registration-two-col">
              <label className="form-field"><span>Settlement mobile number</span><input required inputMode="tel" autoComplete="tel" placeholder="0551234567" value={form.settlementMsisdn} onChange={(event) => setForm({ ...form, settlementMsisdn: event.target.value })} /></label>
              <label className="form-field"><span>Settlement account name</span><input required minLength="2" maxLength="160" value={form.settlementAccountName} onChange={(event) => setForm({ ...form, settlementAccountName: event.target.value })} /></label>
            </div>
            <h3>Initial institution administrator</h3>
            <div className="registration-two-col">
              <label className="form-field"><span>First name</span><input required maxLength="100" autoComplete="given-name" value={form.adminFirstName} onChange={(event) => setForm({ ...form, adminFirstName: event.target.value })} /></label>
              <label className="form-field"><span>Last name</span><input required maxLength="100" autoComplete="family-name" value={form.adminLastName} onChange={(event) => setForm({ ...form, adminLastName: event.target.value })} /></label>
            </div>
            <label className="form-field"><span>Administrator email</span><input required type="email" maxLength="255" autoComplete="email" value={form.adminEmail} onChange={(event) => setForm({ ...form, adminEmail: event.target.value })} /></label>
            <label className="form-field"><span>Create password</span><input required type="password" minLength="12" maxLength="128" autoComplete="new-password" value={form.adminPassword} onChange={(event) => setForm({ ...form, adminPassword: event.target.value })} /><small>At least 12 characters. This account will work after approval.</small></label>
            <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Submitting…' : 'Submit institution application'} <span>→</span></button>
          </form>

          <section className="application-status">
            <h3>Check an application</h3>
            {application && <div className="tracking-code"><strong>Save your tracking code</strong><span>Application ID: <code>{application.id}</code></span><span>Tracking code: <code>{application.trackingToken}</code></span><small>The tracking code is shown only once. Anyone with it can view this application’s status.</small></div>}
            <form onSubmit={checkStatus}>
              <label className="form-field"><span>Application ID</span><input required value={applicationId} onChange={(event) => setApplicationId(event.target.value)} /></label>
              <label className="form-field"><span>Tracking code</span><input required value={trackingToken} onChange={(event) => setTrackingToken(event.target.value)} /></label>
              <button className="button button-outline" disabled={busy || !applicationId || !trackingToken}>Check status</button>
            </form>
            {status && <div className="application-result"><strong>{status.institutionName || application?.institutionName || 'Institution application'} · {status.status}</strong>
              {status.status === 'PENDING' && <p>Your application is awaiting platform review. Save your tracking code and check again later.</p>}
              {status.status === 'APPROVED' && <p>Your workspace is ready. <Link to="/login">Sign in to the Institution Portal</Link> using the administrator email and password from the application.</p>}
              {status.status === 'REJECTED' && <p>Review note: {status.reviewerNote || 'Contact XORGANAM support for details.'}</p>}
            </div>}
          </section>
          <p className="login-register-link"><Link to="/login">Back to institution sign in</Link></p>
        </div>
      </section>
    </main>
  )
}
