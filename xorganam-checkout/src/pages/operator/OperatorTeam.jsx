import { useEffect, useState } from 'react'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'

const ROLES = [
  { value: 'TENANT_ADMIN', label: 'Admin — full control, including team management' },
  { value: 'TENANT_MANAGER', label: 'Manager — merchants, transactions, team' },
  { value: 'TENANT_OPERATOR', label: 'Operator — initiate collections and payouts' },
  { value: 'TENANT_VIEWER', label: 'Viewer — read-only' }
]

const ROLE_LABELS = Object.fromEntries(ROLES.map((r) => [r.value, r.label.split(' — ')[0]]))

const initialForm = {
  firstName: '',
  lastName: '',
  email: '',
  phoneNumber: '',
  password: '',
  role: 'TENANT_OPERATOR'
}

export default function OperatorTeam() {
  const { user, hasMinRole } = useOperatorAuth()
  const canManage = hasMinRole('TENANT_MANAGER')

  const [members, setMembers] = useState([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)

  const [form, setForm] = useState(initialForm)
  const [creating, setCreating] = useState(false)

  function load() {
    if (!user?.tenantId) return
    setLoading(true)
    operatorApi
      .listUsers(user.tenantId)
      .then(setMembers)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(load, [user])

  async function handleCreate(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    setCreating(true)
    try {
      await operatorApi.createUser({ tenantId: user.tenantId, ...form })
      setNotice(`${form.firstName} ${form.lastName} added to your team.`)
      setForm(initialForm)
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setCreating(false)
    }
  }

  async function toggleActive(member) {
    setError('')
    setNotice('')
    try {
      await operatorApi.updateUserStatus(member.id, !member.isActive)
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  async function changeRole(member, role) {
    setError('')
    setNotice('')
    try {
      await operatorApi.assignRole(member.id, role)
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div>
      <div className="portal-header">
        <div>
          <h1>Team</h1>
          <p>The people who can log in and manage this account alongside you.</p>
        </div>
      </div>

      {error && <div className="status-banner error"><span className="status-icon">⚠</span><span>{error}</span></div>}
      {notice && <div className="status-banner success"><span className="status-icon">✓</span><span>{notice}</span></div>}

      {!canManage && (
        <div className="status-banner pending" style={{ marginBottom: 16 }}>
          <span className="status-icon">i</span>
          <span>Your role can view the team but not make changes. Ask an Admin or Manager for access.</span>
        </div>
      )}

      <div className="card">
        <h2>Team members</h2>
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : members.length === 0 ? (
          <div className="empty-state">No team members yet.</div>
        ) : (
          <table className="ledger">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th>{canManage && <th></th>}</tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>{m.firstName} {m.lastName}</td>
                  <td className="mono">{m.email}</td>
                  <td>
                    {canManage && m.id !== user.id ? (
                      <select value={m.role} onChange={(e) => changeRole(m, e.target.value)}>
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>{ROLE_LABELS[r.value]}</option>
                        ))}
                      </select>
                    ) : (
                      ROLE_LABELS[m.role] || m.role
                    )}
                  </td>
                  <td>
                    <span className={`status-pill ${m.isActive ? 'approved' : 'rejected'}`}>{m.isActive ? 'Active' : 'Inactive'}</span>
                  </td>
                  {canManage && (
                    <td>
                      {m.id !== user.id && (
                        <button className="btn btn-secondary btn-sm" onClick={() => toggleActive(m)}>
                          {m.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {canManage && (
        <form className="card" onSubmit={handleCreate}>
          <h2>Add a team member</h2>
          <div className="two-col">
            <div className="field">
              <label>First name</label>
              <input required value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} />
            </div>
            <div className="field">
              <label>Last name</label>
              <input required value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} />
            </div>
          </div>
          <div className="two-col">
            <div className="field">
              <label>Email</label>
              <input required type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div className="field">
              <label>Phone number</label>
              <input value={form.phoneNumber} onChange={(e) => setForm((f) => ({ ...f, phoneNumber: e.target.value }))} placeholder="0551234567" />
            </div>
          </div>
          <div className="two-col">
            <div className="field">
              <label>Temporary password</label>
              <input required type="password" minLength={10} value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
            </div>
            <div className="field">
              <label>Role</label>
              <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>
          <button className="btn btn-primary" disabled={creating}>{creating ? 'Adding…' : 'Add team member'}</button>
        </form>
      )}
    </div>
  )
}
