import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { tenantsApi } from '../../api/tenants'
import StatusChip from '../../components/StatusChip'

export default function TenantsList() {
  const [tenants, setTenants] = useState([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ companyName: '', contactPhone: '', contactEmail: '', status: 'PENDING' })

  function load() {
    setLoading(true)
    tenantsApi
      .list()
      .then(setTenants)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  async function createTenant(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    try {
      await tenantsApi.create(form)
      setNotice('Tenant created.')
      setForm({ companyName: '', contactPhone: '', contactEmail: '', status: 'PENDING' })
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Tenants & KYC</h1>
          <p>
            Operators register themselves from the checkout app's Operator portal. Review their
            KYC documents here and activate Eganow credentials once approved.
          </p>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <form className="panel" onSubmit={createTenant}>
        <h2>Add tenant</h2>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="field">
            <label>Company</label>
            <input required value={form.companyName} onChange={(e) => setForm((f) => ({ ...f, companyName: e.target.value }))} />
          </div>
          <div className="field">
            <label>Phone</label>
            <input required value={form.contactPhone} onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))} />
          </div>
          <div className="field">
            <label>Email</label>
            <input required type="email" value={form.contactEmail} onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))} />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
              <option value="PENDING">Pending</option>
              <option value="UNDER_REVIEW">Under review</option>
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </div>
        </div>
        <div className="form-actions">
          <button className="btn btn-primary">Create tenant</button>
        </div>
      </form>

      <div className="panel">
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : tenants.length === 0 ? (
          <div className="empty-state">No tenants have registered yet.</div>
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th>Company</th>
                <th>Contact</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td>{t.companyName}</td>
                  <td className="mono">{t.contactEmail}</td>
                  <td><StatusChip status={t.status} /></td>
                  <td>
                    <Link to={`/tenants/${t.id}`} className="btn btn-secondary btn-sm">
                      Review
                    </Link>
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
