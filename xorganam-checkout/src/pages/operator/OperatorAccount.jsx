import { useCallback, useEffect, useState } from 'react'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi, operatorAuth } from '../../api/client'

function statusClass(status) {
  return (status || '').toLowerCase().replace(/_/g, '')
}

export default function OperatorAccount() {
  const { user } = useOperatorAuth()
  const [tenant, setTenant] = useState(null)
  const [sessions, setSessions] = useState([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [uploadForm, setUploadForm] = useState({ kycType: 'BUSINESS', entries: [] })
  const [uploading, setUploading] = useState(false)
  const [recoveryCode, setRecoveryCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState([])
  const [rotatingRecoveryCodes, setRotatingRecoveryCodes] = useState(false)

  const load = useCallback(() => {
    if (!user?.tenantId) return
    operatorApi.getTenant(user.tenantId).then(setTenant).catch((err) => setError(err.message))
  }, [user])

  useEffect(() => {
    load()
  }, [load])

  const loadSessions = useCallback(async () => {
    try {
      const result = await operatorAuth.listSessions()
      setSessions(result.sessions || [])
    } catch (requestError) {
      setError(requestError.message)
    }
  }, [])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  async function handleUpload(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    if (!uploadForm.entries || uploadForm.entries.length === 0) {
      setError('Choose at least one document file first.')
      return
    }
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('kycType', uploadForm.kycType)
      // Append per-file metadata in the same order as files so the server can
      // accept arrays of documentType/documentNumber and associate them. The
      // form-level values are defaults when a file has no per-file override.
      for (const entry of uploadForm.entries) {
        formData.append('documentType', (entry.documentType || uploadForm.documentType || '').trim())
        formData.append('documentNumber', (entry.documentNumber || uploadForm.documentNumber || '').trim())
        formData.append('document', entry.file)
      }

      await operatorApi.submitKycDocument(user.tenantId, formData)
      setNotice('Document submitted for review.')
      setUploadForm({ kycType: 'BUSINESS', entries: [] })
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  async function rotateRecoveryCodes(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setRotatingRecoveryCodes(true)
    try {
      const result = await operatorAuth.rotateMfaRecoveryCodes(recoveryCode)
      setRecoveryCodes(result.recoveryCodes || [])
      setRecoveryCode('')
      setNotice('Recovery codes replaced. Save the new set now; previous codes no longer work.')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setRotatingRecoveryCodes(false)
    }
  }

  async function revokeSession(session) {
    if (!window.confirm(`Sign out the device last seen ${new Date(session.last_seen_at).toLocaleString()}?`)) return
    setError('')
    setNotice('')
    try {
      await operatorAuth.revokeSession(session.id)
      setSessions((current) => current.filter((item) => item.id !== session.id))
      setNotice('Device session revoked.')
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  if (!tenant) {
    return <div className="empty-state">{error || 'Loading…'}</div>
  }

  return (
    <div>
      <div className="portal-header">
        <div>
          <h1>Account & KYC</h1>
          <p>Your business's onboarding status and submitted documents.</p>
        </div>
      </div>

      <div className="card">
        <h2>Status</h2>
        <p style={{ fontSize: 13.5 }}>
          <span className={`status-pill ${statusClass(tenant.status)}`}>{tenant.status.replace('_', ' ')}</span>
        </p>
        {tenant.status === 'ACTIVE' ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10 }}>
            You're approved. Payments go live once an admin enables your Eganow credentials.
          </p>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10 }}>
            Submit your KYC/KYB documents below. An admin will review them before you can accept payments.
          </p>
        )}
      </div>

      {error && <div className="status-banner error"><span className="status-icon">⚠</span><span>{error}</span></div>}
      {notice && <div className="status-banner success"><span className="status-icon">✓</span><span>{notice}</span></div>}

      <section className="card">
        <h2>Sign-in recovery codes</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)' }}>Use a current authenticator code to replace your recovery-code set. Previous codes stop working immediately.</p>
        <form onSubmit={rotateRecoveryCodes}>
          <div className="field"><label htmlFor="rotate-mfa-code">Current authenticator code</label><input id="rotate-mfa-code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /></div>
          <button className="btn btn-primary" disabled={rotatingRecoveryCodes}>{rotatingRecoveryCodes ? 'Replacing codes…' : 'Replace recovery codes'}</button>
        </form>
        {recoveryCodes.length > 0 && <ol className="mfa-recovery-codes">{recoveryCodes.map((item) => <li className="mono" key={item}>{item}</li>)}</ol>}
      </section>

      <section className="card">
        <h2>Active sessions</h2>
        {sessions.length === 0 ? <p style={{ fontSize: 13, color: 'var(--muted)' }}>No active sessions found.</p> : <div className="table-wrap"><table className="ledger">
          <thead><tr><th>Device</th><th>IP address</th><th>Last seen</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>{sessions.map((session) => <tr key={session.id}>
            <td style={{ overflowWrap: 'anywhere' }}>{session.user_agent || 'Unknown device'}</td>
            <td className="mono">{session.ip_address || '—'}</td>
            <td>{new Date(session.last_seen_at).toLocaleString()}</td>
            <td>{session.current ? <span className="status-pill approved">Current device</span> : <span className="status-pill pending">Active</span>}</td>
            <td>{session.current ? '—' : <button className="btn btn-link btn-sm" onClick={() => revokeSession(session)}>Revoke</button>}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>

      {tenant.documents?.length > 0 && (
        <div className="card">
          <h2>Submitted documents</h2>
          {tenant.documents.map((d) => (
            <div className="kv-row" key={d.id}>
              <span>{d.documentType}</span>
              <span className={`status-pill ${statusClass(d.verificationStatus)}`}>{d.verificationStatus}</span>
            </div>
          ))}
        </div>
      )}

      <form className="card" onSubmit={handleUpload}>
        <h2>Submit a document</h2>
        <div className="two-col">
          <div className="field">
            <label>Document category</label>
            <select value={uploadForm.kycType} onChange={(e) => setUploadForm((f) => ({ ...f, kycType: e.target.value }))}>
              <option value="INDIVIDUAL">Individual (KYC)</option>
              <option value="BUSINESS">Business (KYB)</option>
            </select>
          </div>
          <div className="field">
            <label>Document number</label>
            <input required maxLength={100} autoComplete="off" value={uploadForm.documentNumber} onChange={(e) => setUploadForm((f) => ({ ...f, documentNumber: e.target.value }))} />
          </div>
        </div>
        <div className="field">
          <label>Document type</label>
          <input required maxLength={100} placeholder="e.g. Certificate of Incorporation" value={uploadForm.documentType} onChange={(e) => setUploadForm((f) => ({ ...f, documentType: e.target.value }))} />
        </div>
        <div className="field">
          <label>Files</label>
          <input required type="file" multiple onChange={(e) => {
            const files = Array.from(e.target.files || [])
            setUploadForm((f) => ({ ...f, entries: files.map((file) => ({ file, documentType: '', documentNumber: '' })) }))
          }} />
        </div>

        {uploadForm.entries && uploadForm.entries.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <h3 style={{ marginTop: 0, marginBottom: 8 }}>Per-file metadata</h3>
            {uploadForm.entries.map((entry, idx) => (
              <div key={idx} style={{ border: '1px solid var(--line)', padding: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 13, marginBottom: 6 }}><strong>File:</strong> {entry.file.name}</div>
                <div className="two-col">
                  <div className="field">
                    <label>Document type</label>
                    <input maxLength={100} value={entry.documentType} onChange={(e) => setUploadForm((f) => {
                      const next = { ...f }
                      next.entries = next.entries.slice()
                      next.entries[idx] = { ...next.entries[idx], documentType: e.target.value }
                      return next
                    })} />
                  </div>
                  <div className="field">
                    <label>Document number</label>
                    <input maxLength={100} autoComplete="off" value={entry.documentNumber} onChange={(e) => setUploadForm((f) => {
                      const next = { ...f }
                      next.entries = next.entries.slice()
                      next.entries[idx] = { ...next.entries[idx], documentNumber: e.target.value }
                      return next
                    })} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <button className="btn btn-primary" disabled={uploading}>{uploading ? 'Uploading…' : 'Submit document'}</button>
      </form>
    </div>
  )
}
