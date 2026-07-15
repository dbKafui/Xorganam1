import { useCallback, useEffect, useState } from 'react'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'

function statusClass(status) {
  return (status || '').toLowerCase().replace(/_/g, '')
}

export default function OperatorAccount() {
  const { user } = useOperatorAuth()
  const [tenant, setTenant] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [uploadForm, setUploadForm] = useState({ kycType: 'BUSINESS', documentType: '', documentNumber: '', file: null })
  const [uploading, setUploading] = useState(false)

  const load = useCallback(() => {
    if (!user?.tenantId) return
    operatorApi.getTenant(user.tenantId).then(setTenant).catch((err) => setError(err.message))
  }, [user])

  useEffect(() => {
    load()
  }, [load])

  async function handleUpload(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    if (!uploadForm.file) {
      setError('Choose a document file first.')
      return
    }
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('kycType', uploadForm.kycType)
      formData.append('documentType', uploadForm.documentType)
      formData.append('documentNumber', uploadForm.documentNumber)
      formData.append('document', uploadForm.file)

      await operatorApi.submitKycDocument(user.tenantId, formData)
      setNotice('Document submitted for review.')
      setUploadForm({ kycType: 'BUSINESS', documentType: '', documentNumber: '', file: null })
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
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
            <input required value={uploadForm.documentNumber} onChange={(e) => setUploadForm((f) => ({ ...f, documentNumber: e.target.value }))} />
          </div>
        </div>
        <div className="field">
          <label>Document type</label>
          <input required placeholder="e.g. Certificate of Incorporation" value={uploadForm.documentType} onChange={(e) => setUploadForm((f) => ({ ...f, documentType: e.target.value }))} />
        </div>
        <div className="field">
          <label>File</label>
          <input required type="file" onChange={(e) => setUploadForm((f) => ({ ...f, file: e.target.files?.[0] || null }))} />
        </div>
        <button className="btn btn-primary" disabled={uploading}>{uploading ? 'Uploading…' : 'Submit document'}</button>
      </form>
    </div>
  )
}
