import { useEffect, useState } from 'react'
import { merchantsApi } from '../api/merchants'
import { tenantsApi } from '../api/tenants'

const emptyForm = {
  tenantId: '',
  displayName: '',
  mobileMoneyNumber: '',
  networkProvider: 'MTNGH',
  payoutMode: 'MANUAL',
  eganowCollectionAccountId: '',
  eganowPayoutAccountId: ''
}

export default function Merchants() {
  const [tenants, setTenants] = useState([])
  const [merchants, setMerchants] = useState([])
  const [form, setForm] = useState(emptyForm)
  const [editForm, setEditForm] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)

  function load() {
    setLoading(true)
    Promise.all([
      tenantsApi.list().then(setTenants),
      merchantsApi.all().then(setMerchants)
    ])
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  async function createMerchant(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    try {
      await merchantsApi.create(form)
      setNotice('Merchant created.')
      setForm(emptyForm)
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  async function updateMerchant(e) {
    e.preventDefault()
    if (!editForm) return
    setError('')
    setNotice('')
    try {
      await merchantsApi.update(editForm.id, editForm)
      setNotice('Merchant updated.')
      setEditForm(null)
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

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Merchants</h1>
          <p>Create, edit, deactivate, or delete merchants across every tenant.</p>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <form className="panel" onSubmit={createMerchant}>
        <h2>Add merchant</h2>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field">
            <label>Tenant</label>
            <select required value={form.tenantId} onChange={(e) => setForm((f) => ({ ...f, tenantId: e.target.value }))}>
              <option value="">Select tenant</option>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>{tenant.companyName}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Name</label>
            <input required value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} />
          </div>
          <div className="field">
            <label>MoMo number</label>
            <input required value={form.mobileMoneyNumber} onChange={(e) => setForm((f) => ({ ...f, mobileMoneyNumber: e.target.value }))} />
          </div>
          <div className="field">
            <label>Network</label>
            <select value={form.networkProvider} onChange={(e) => setForm((f) => ({ ...f, networkProvider: e.target.value }))}>
              <option value="MTNGH">MTN</option>
              <option value="TCELGH">Vodafone</option>
              <option value="ATGH">AirtelTigo</option>
            </select>
          </div>
          <div className="field">
            <label>Payout mode</label>
            <select value={form.payoutMode} onChange={(e) => setForm((f) => ({ ...f, payoutMode: e.target.value }))}>
              <option value="MANUAL">Collection only</option>
              <option value="AUTO_SWEEP">Collect for me</option>
            </select>
          </div>
          <div className="field">
            <label>Collection account</label>
            <input required value={form.eganowCollectionAccountId} onChange={(e) => setForm((f) => ({ ...f, eganowCollectionAccountId: e.target.value }))} />
          </div>
          <div className="field">
            <label>Payout account</label>
            <input required value={form.eganowPayoutAccountId} onChange={(e) => setForm((f) => ({ ...f, eganowPayoutAccountId: e.target.value }))} />
          </div>
        </div>
        <div className="form-actions">
          <button className="btn btn-primary">Create merchant</button>
        </div>
      </form>

      {editForm && (
        <form className="panel" onSubmit={updateMerchant}>
          <h2>Edit merchant</h2>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="field">
              <label>Tenant</label>
              <input value={editForm.tenantCompanyName || ''} disabled />
            </div>
            <div className="field">
              <label>Name</label>
              <input required value={editForm.displayName} onChange={(e) => setEditForm((f) => ({ ...f, displayName: e.target.value }))} />
            </div>
            <div className="field">
              <label>MoMo number</label>
              <input required value={editForm.mobileMoneyNumber} onChange={(e) => setEditForm((f) => ({ ...f, mobileMoneyNumber: e.target.value }))} />
            </div>
            <div className="field">
              <label>Network</label>
              <select value={editForm.networkProvider} onChange={(e) => setEditForm((f) => ({ ...f, networkProvider: e.target.value }))}>
                <option value="MTNGH">MTN</option>
                <option value="TCELGH">Vodafone</option>
                <option value="ATGH">AirtelTigo</option>
              </select>
            </div>
            <div className="field">
              <label>Payout mode</label>
              <select value={editForm.payoutMode} onChange={(e) => setEditForm((f) => ({ ...f, payoutMode: e.target.value }))}>
                <option value="MANUAL">Collection only</option>
                <option value="AUTO_SWEEP">Collect for me</option>
              </select>
            </div>
            <div className="field">
              <label>Status</label>
              <select value={editForm.isActive ? 'true' : 'false'} onChange={(e) => setEditForm((f) => ({ ...f, isActive: e.target.value === 'true' }))}>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </div>
          </div>
          <div className="form-actions">
            <button className="btn btn-primary">Save changes</button>
            <button type="button" className="btn btn-secondary" onClick={() => setEditForm(null)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="panel">
        <h2>All merchants</h2>
        {loading ? (
          <div className="empty-state">Loading...</div>
        ) : merchants.length === 0 ? (
          <div className="empty-state">No merchants yet.</div>
        ) : (
          <table className="ledger">
            <thead>
              <tr><th>Tenant</th><th>Name</th><th>MoMo</th><th>Mode</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {merchants.map((merchant) => (
                <tr key={merchant.id}>
                  <td>{merchant.tenantCompanyName}</td>
                  <td>{merchant.displayName}</td>
                  <td className="mono">{merchant.mobileMoneyNumber}</td>
                  <td>{merchant.payoutMode === 'AUTO_SWEEP' ? 'Collect for me' : 'Collection only'}</td>
                  <td>{merchant.isActive ? 'Active' : 'Inactive'}</td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => setEditForm(merchant)}>Edit</button>
                    <button className="btn btn-danger btn-sm" onClick={() => deleteMerchant(merchant.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
