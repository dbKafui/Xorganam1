import { useEffect, useState, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { tenantsApi } from '../../api/tenants'
import { merchantsApi } from '../../api/merchants'
import StatusChip from '../../components/StatusChip'
import { BASE_URL } from '../../api/client'

const TABS = ['overview', 'kyc', 'eganow', 'notifications']

export default function TenantDetail() {
  const { tenantId } = useParams()
  const navigate = useNavigate()
  const [tenant, setTenant] = useState(null)
  const [tenantForm, setTenantForm] = useState(null)
  const [merchants, setMerchants] = useState([])
  const [merchantForm, setMerchantForm] = useState({
    displayName: '',
    mobileMoneyNumber: '',
    networkProvider: 'MTNGH',
    payoutMode: 'MANUAL',
    eganowCollectionAccountId: '',
    eganowPayoutAccountId: ''
  })
  const [editMerchantForm, setEditMerchantForm] = useState(null)
  const [tab, setTab] = useState('overview')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [rejectReasons, setRejectReasons] = useState({})

  const load = useCallback(() => {
    tenantsApi.detail(tenantId).then((t) => {
      setTenant(t)
      setTenantForm({
        companyName: t.companyName,
        contactPhone: t.contactPhone,
        contactEmail: t.contactEmail,
        status: t.status
      })
    }).catch((err) => setError(err.message))
    tenantsApi.getConfig(tenantId).then((cfg) => {
      setEganowForm((f) => ({
        ...f,
        serviceName: cfg.eganow_merchant_code || f.serviceName,
        isEnabled: cfg.eganow_enabled ?? f.isEnabled,
        eganowBaseUrl: cfg.eganow_base_url || f.eganowBaseUrl,
        eganowCallbackUrl: cfg.eganow_callback_url || f.eganowCallbackUrl
      }))
    }).catch(() => {})
    merchantsApi.list(tenantId).then(setMerchants).catch(() => {})
  }, [tenantId])

  useEffect(() => {
    load()
  }, [load])

  async function handleReview(documentId, decision) {
    setError('')
    setNotice('')
    try {
      await tenantsApi.reviewKycDocument(documentId, {
        decision,
        rejectionReason: decision === 'REJECTED' ? rejectReasons[documentId] || 'Not specified' : undefined
      })
      setNotice(`Document marked ${decision}.`)
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  async function saveTenant(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    try {
      const updated = await tenantsApi.update(tenantId, tenantForm)
      setTenant(updated)
      setTenantForm({
        companyName: updated.companyName,
        contactPhone: updated.contactPhone,
        contactEmail: updated.contactEmail,
        status: updated.status
      })
      setNotice('Tenant updated.')
    } catch (err) {
      setError(err.message)
    }
  }

  async function deleteTenant() {
    setError('')
    setNotice('')
    try {
      const result = await tenantsApi.remove(tenantId)
      if (result.deleted) {
        navigate('/tenants')
      } else {
        setNotice(result.message || 'Tenant suspended.')
        load()
      }
    } catch (err) {
      setError(err.message)
    }
  }

  async function createMerchant(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    try {
      await merchantsApi.create({ ...merchantForm, tenantId })
      setNotice('Merchant created.')
      setMerchantForm({
        displayName: '',
        mobileMoneyNumber: '',
        networkProvider: 'MTNGH',
        payoutMode: 'MANUAL',
        eganowCollectionAccountId: '',
        eganowPayoutAccountId: ''
      })
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  async function updateMerchant(e) {
    e.preventDefault()
    if (!editMerchantForm) return
    setError('')
    setNotice('')
    try {
      await merchantsApi.update(editMerchantForm.id, editMerchantForm)
      setNotice('Merchant updated.')
      setEditMerchantForm(null)
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  async function deleteMerchant(merchantId) {
    setError('')
    setNotice('')
    try {
      const result = await merchantsApi.remove(merchantId)
      setNotice(result.message || 'Merchant deleted.')
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  const [eganowForm, setEganowForm] = useState({ apiUsername: '', apiPassword: '', eganowBaseUrl: '', eganowCallbackUrl: '', xAuth: '', webhookSecret: '', serviceName: '', isEnabled: true })
  const [notifForm, setNotifForm] = useState({
    smsProviderName: '', smsProviderKey: '', smsSenderId: '', smsEnabled: true,
    emailProviderName: '', emailProviderKey: '', emailFromAddress: '', emailEnabled: false
  })

  async function saveEganow(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    try {
      await tenantsApi.updateEganowCredentials(tenantId, eganowForm)
      setNotice('Eganow credentials updated.')
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  async function saveNotifications(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    try {
      await tenantsApi.updateNotificationSettings(tenantId, notifForm)
      setNotice('Notification configuration updated.')
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  if (!tenant || !tenantForm) {
    return <div className="empty-state">{error || 'Loading…'}</div>
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{tenant.companyName}</h1>
          <p>Status: <StatusChip status={tenant.status} /></p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to={`/transactions?tenantId=${tenantId}`} className="btn btn-secondary">View transactions</Link>
          <button className="btn btn-danger" onClick={deleteTenant}>Delete</button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <div className="tabs">
        {TABS.map((t) => (
          <div key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {t === 'kyc' ? 'KYC documents' : t === 'eganow' ? 'Eganow API configuration' : t === 'notifications' ? 'Notifications' : 'Overview'}
          </div>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="panel">
            <h2>Tenant details</h2>
            <form onSubmit={saveTenant}>
              <div className="form-grid">
                <div className="field">
                  <label>Company</label>
                  <input value={tenantForm.companyName} onChange={(e) => setTenantForm((f) => ({ ...f, companyName: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Phone</label>
                  <input value={tenantForm.contactPhone} onChange={(e) => setTenantForm((f) => ({ ...f, contactPhone: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Email</label>
                  <input type="email" value={tenantForm.contactEmail} onChange={(e) => setTenantForm((f) => ({ ...f, contactEmail: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Status</label>
                  <select value={tenantForm.status} onChange={(e) => setTenantForm((f) => ({ ...f, status: e.target.value }))}>
                    <option value="PENDING">Pending</option>
                    <option value="UNDER_REVIEW">Under review</option>
                    <option value="ACTIVE">Active</option>
                    <option value="REJECTED">Rejected</option>
                    <option value="SUSPENDED">Suspended</option>
                  </select>
                </div>
              </div>
              <div className="form-actions">
                <button className="btn btn-primary">Save tenant</button>
              </div>
            </form>
            <div className="form-grid single">
              <div><strong>Registered:</strong> <span className="mono">{new Date(tenant.createdAt).toLocaleString()}</span></div>
              {tenant.approvedAt && <div><strong>Approved:</strong> <span className="mono">{new Date(tenant.approvedAt).toLocaleString()}</span></div>}
            </div>
          </div>

          <div className="panel">
            <h2>Merchants ({merchants.length})</h2>
            <form onSubmit={createMerchant} style={{ marginBottom: 16 }}>
              <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                <div className="field">
                  <label>Name</label>
                  <input required value={merchantForm.displayName} onChange={(e) => setMerchantForm((f) => ({ ...f, displayName: e.target.value }))} />
                </div>
                <div className="field">
                  <label>MoMo number</label>
                  <input required value={merchantForm.mobileMoneyNumber} onChange={(e) => setMerchantForm((f) => ({ ...f, mobileMoneyNumber: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Network</label>
                  <select value={merchantForm.networkProvider} onChange={(e) => setMerchantForm((f) => ({ ...f, networkProvider: e.target.value }))}>
                    <option value="MTNGH">MTN</option>
                    <option value="TCELGH">Vodafone</option>
                    <option value="ATGH">AirtelTigo</option>
                  </select>
                </div>
                <div className="field">
                  <label>Payout mode</label>
                  <select value={merchantForm.payoutMode} onChange={(e) => setMerchantForm((f) => ({ ...f, payoutMode: e.target.value }))}>
                    <option value="MANUAL">Collection only</option>
                    <option value="AUTO_SWEEP">Collect for me</option>
                  </select>
                </div>
                <div className="field">
                  <label>Collection account</label>
                  <input required value={merchantForm.eganowCollectionAccountId} onChange={(e) => setMerchantForm((f) => ({ ...f, eganowCollectionAccountId: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Payout account</label>
                  <input required value={merchantForm.eganowPayoutAccountId} onChange={(e) => setMerchantForm((f) => ({ ...f, eganowPayoutAccountId: e.target.value }))} />
                </div>
              </div>
              <div className="form-actions">
                <button className="btn btn-primary">Add merchant</button>
              </div>
            </form>
            {editMerchantForm && (
              <form onSubmit={updateMerchant} style={{ marginBottom: 16 }}>
                <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                  <div className="field">
                    <label>Name</label>
                    <input required value={editMerchantForm.displayName} onChange={(e) => setEditMerchantForm((f) => ({ ...f, displayName: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label>MoMo number</label>
                    <input required value={editMerchantForm.mobileMoneyNumber} onChange={(e) => setEditMerchantForm((f) => ({ ...f, mobileMoneyNumber: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label>Network</label>
                    <select value={editMerchantForm.networkProvider} onChange={(e) => setEditMerchantForm((f) => ({ ...f, networkProvider: e.target.value }))}>
                      <option value="MTNGH">MTN</option>
                      <option value="TCELGH">Vodafone</option>
                      <option value="ATGH">AirtelTigo</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Payout mode</label>
                    <select value={editMerchantForm.payoutMode} onChange={(e) => setEditMerchantForm((f) => ({ ...f, payoutMode: e.target.value }))}>
                      <option value="MANUAL">Collection only</option>
                      <option value="AUTO_SWEEP">Collect for me</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Status</label>
                    <select value={editMerchantForm.isActive ? 'true' : 'false'} onChange={(e) => setEditMerchantForm((f) => ({ ...f, isActive: e.target.value === 'true' }))}>
                      <option value="true">Active</option>
                      <option value="false">Inactive</option>
                    </select>
                  </div>
                </div>
                <div className="form-actions">
                  <button className="btn btn-primary">Save changes</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setEditMerchantForm(null)}>Cancel</button>
                </div>
              </form>
            )}
            {merchants.length === 0 ? (
              <div className="empty-state">No merchants onboarded yet.</div>
            ) : (
              <table className="ledger">
                <thead>
                  <tr><th>Name</th><th>MoMo number</th><th>Payout mode</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  {merchants.map((m) => (
                    <tr key={m.id}>
                      <td>{m.displayName}</td>
                      <td className="mono">{m.mobileMoneyNumber}</td>
                      <td>{m.payoutMode === 'AUTO_SWEEP' ? 'Collect for me' : 'Collection only'}</td>
                      <td>{m.isActive ? 'Active' : 'Inactive'}</td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => setEditMerchantForm(m)}>Edit</button>
                        <button className="btn btn-danger btn-sm" onClick={() => deleteMerchant(m.id)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {tab === 'kyc' && (
        <div className="panel">
          <h2>KYC / KYB documents</h2>
          {tenant.documents.length === 0 ? (
            <div className="empty-state">No documents submitted yet.</div>
          ) : (
            <table className="ledger">
              <thead>
                <tr><th>Document type</th><th>Status</th><th>Submitted</th><th>File</th><th></th></tr>
              </thead>
              <tbody>
                {tenant.documents.map((d) => (
                  <tr key={d.id}>
                    <td>{d.documentType}</td>
                    <td><StatusChip status={d.verificationStatus} /></td>
                    <td className="mono">{new Date(d.createdAt).toLocaleDateString()}</td>
                    <td>
                      {d.documentUrl ? (
                        <a href={`${BASE_URL.replace('/api/v1','')}${d.documentUrl}`} target="_blank" rel="noopener noreferrer">View</a>
                      ) : (
                        <span className="helper-text">No file</span>
                      )}
                    </td>
                    <td>
                      {d.verificationStatus === 'PENDING' || d.verificationStatus === 'UNDER_REVIEW' ? (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <button className="btn btn-primary btn-sm" onClick={() => handleReview(d.id, 'APPROVED')}>Approve</button>
                          <input
                            placeholder="Rejection reason"
                            style={{ fontSize: 12, padding: '4px 6px', border: '1px solid var(--line)', borderRadius: 4 }}
                            value={rejectReasons[d.id] || ''}
                            onChange={(e) => setRejectReasons((r) => ({ ...r, [d.id]: e.target.value }))}
                          />
                          <button className="btn btn-danger btn-sm" onClick={() => handleReview(d.id, 'REJECTED')}>Reject</button>
                        </div>
                      ) : (
                        <span className="helper-text">Reviewed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'eganow' && (
        <form className="panel" onSubmit={saveEganow}>
          <h2>Eganow API configuration</h2>
          <p className="helper-text">Enter the service credentials from the Eganow merchant dashboard for the selected payment service.</p>
          {tenant.status !== 'ACTIVE' && (
            <div className="alert alert-error">This tenant must complete KYC approval before Eganow can be enabled.</div>
          )}
          <div className="form-grid">
            <div className="field">
              <label>API username</label>
              <input value={eganowForm.apiUsername} onChange={(e) => setEganowForm((f) => ({ ...f, apiUsername: e.target.value }))} placeholder="Leave blank to keep current value" />
            </div>
            <div className="field">
              <label>API password</label>
              <input type="password" value={eganowForm.apiPassword} onChange={(e) => setEganowForm((f) => ({ ...f, apiPassword: e.target.value }))} placeholder="Leave blank to keep current value" />
            </div>
            <div className="field">
              <label>Eganow API base URL</label>
              <input value={eganowForm.eganowBaseUrl} onChange={(e) => setEganowForm((f) => ({ ...f, eganowBaseUrl: e.target.value }))} placeholder="Leave blank to keep current value" />
            </div>
            <div className="field">
              <label>Webhook callback URL</label>
              <input value={eganowForm.eganowCallbackUrl} onChange={(e) => setEganowForm((f) => ({ ...f, eganowCallbackUrl: e.target.value }))} placeholder="e.g. https://your-domain.com/api/v1/webhooks/eganow" />
            </div>
            <div className="field">
              <label>x-Auth</label>
              <input type="password" value={eganowForm.xAuth} onChange={(e) => setEganowForm((f) => ({ ...f, xAuth: e.target.value }))} placeholder="Leave blank to keep current value" />
            </div>
            <div className="field">
              <label>Service name</label>
              <input value={eganowForm.serviceName} onChange={(e) => setEganowForm((f) => ({ ...f, serviceName: e.target.value }))} />
            </div>
            <div className="field">
              <label>Webhook secret</label>
              <input type="password" value={eganowForm.webhookSecret} onChange={(e) => setEganowForm((f) => ({ ...f, webhookSecret: e.target.value }))} placeholder="Leave blank to keep current value" />
            </div>
            <div className="field">
              <label>Status</label>
              <select value={eganowForm.isEnabled} onChange={(e) => setEganowForm((f) => ({ ...f, isEnabled: e.target.value === 'true' }))}>
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </div>
          </div>
          <div className="form-actions">
            <button className="btn btn-primary">Save Eganow API configuration</button>
          </div>
        </form>
      )}

      {tab === 'notifications' && (
        <form className="panel" onSubmit={saveNotifications}>
          <h2>SMS / email configuration</h2>
          <div className="form-grid">
            <div className="field">
              <label>SMS provider</label>
              <input value={notifForm.smsProviderName} onChange={(e) => setNotifForm((f) => ({ ...f, smsProviderName: e.target.value }))} placeholder="Hubtel, Twilio…" />
            </div>
            <div className="field">
              <label>SMS provider key</label>
              <input type="password" value={notifForm.smsProviderKey} onChange={(e) => setNotifForm((f) => ({ ...f, smsProviderKey: e.target.value }))} placeholder="Leave blank to keep current value" />
            </div>
            <div className="field">
              <label>SMS sender ID</label>
              <input value={notifForm.smsSenderId} onChange={(e) => setNotifForm((f) => ({ ...f, smsSenderId: e.target.value }))} maxLength={11} />
            </div>
            <div className="field">
              <label>SMS status</label>
              <select value={notifForm.smsEnabled} onChange={(e) => setNotifForm((f) => ({ ...f, smsEnabled: e.target.value === 'true' }))}>
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </div>
            <div className="field">
              <label>Email provider</label>
              <input value={notifForm.emailProviderName} onChange={(e) => setNotifForm((f) => ({ ...f, emailProviderName: e.target.value }))} />
            </div>
            <div className="field">
              <label>Email provider key</label>
              <input type="password" value={notifForm.emailProviderKey} onChange={(e) => setNotifForm((f) => ({ ...f, emailProviderKey: e.target.value }))} placeholder="Leave blank to keep current value" />
            </div>
            <div className="field">
              <label>From address</label>
              <input type="email" value={notifForm.emailFromAddress} onChange={(e) => setNotifForm((f) => ({ ...f, emailFromAddress: e.target.value }))} />
            </div>
            <div className="field">
              <label>Email status</label>
              <select value={notifForm.emailEnabled} onChange={(e) => setNotifForm((f) => ({ ...f, emailEnabled: e.target.value === 'true' }))}>
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </div>
          </div>
          <div className="form-actions">
            <button className="btn btn-primary">Save notification configuration</button>
          </div>
        </form>
      )}
    </div>
  )
}
