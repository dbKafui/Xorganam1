import { useEffect, useState } from 'react'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'
import { PERMISSION_TYPES, PERMISSION_LABELS, getPermissionLabel, getPermissionDescription, getDefaultPermissionsForRole } from '../../constants/permissions'

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
  role: 'TENANT_OPERATOR',
  merchantId: ''
}

export default function OperatorTeam() {
  const { user, hasMinRole } = useOperatorAuth()
  const canManage = hasMinRole('TENANT_MANAGER')

  const [members, setMembers] = useState([])
  const [merchants, setMerchants] = useState([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)

  const [form, setForm] = useState(initialForm)
  const [creating, setCreating] = useState(false)
  const [selectedUser, setSelectedUser] = useState(null)
  const [selectedUserPermissions, setSelectedUserPermissions] = useState([])
  const [newPermissionType, setNewPermissionType] = useState('')
  const [newPermissionResource, setNewPermissionResource] = useState('')
  const [selectedEditUser, setSelectedEditUser] = useState(null)
  const [editForm, setEditForm] = useState({ firstName: '', lastName: '', phoneNumber: '', role: '' })
  const [merchantAssignmentUser, setMerchantAssignmentUser] = useState(null)

  function load() {
    if (!user?.tenantId) return
    setLoading(true)
    Promise.all([
      operatorApi.listUsers(user.tenantId),
      operatorApi.listMerchants(user.tenantId)
    ])
      .then(([usersData, merchantsData]) => {
        setMembers(usersData)
        setMerchants(merchantsData || [])
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(load, [user])

  async function loadPermissionsFor(userId) {
    try {
      if (!operatorApi.listUserPermissions) {
        console.warn('listUserPermissions not available')
        setSelectedUserPermissions([])
        return
      }
      console.log('Loading permissions for user:', userId)
      const perms = await operatorApi.listUserPermissions(userId)
      console.log('Permissions loaded:', perms)
      setSelectedUserPermissions(perms || [])
    } catch (err) {
      console.error('Error loading permissions:', err)
      setError(`Failed to load permissions: ${err.message}`)
      setSelectedUserPermissions([])
    }
  }

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

  async function changeMerchant(member, merchantId) {
    setError('')
    setNotice('')
    try {
      if (!merchantId) {
        await operatorApi.unassignMerchant(member.id)
      } else {
        await operatorApi.assignMerchant(member.id, merchantId)
      }
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

  function openEdit(member) {
    setSelectedEditUser(member)
    setEditForm({
      firstName: member.firstName,
      lastName: member.lastName,
      phoneNumber: member.phoneNumber || '',
      role: member.role
    })
  }

  function closeEdit() {
    setSelectedEditUser(null)
    setEditForm({ firstName: '', lastName: '', phoneNumber: '', role: '' })
  }

  async function saveEdit() {
    if (!selectedEditUser) return
    setError('')
    setNotice('')
    try {
      await operatorApi.updateUser(selectedEditUser.id, {
        firstName: editForm.firstName,
        lastName: editForm.lastName,
        phoneNumber: editForm.phoneNumber,
        role: editForm.role
      })
      setNotice(`Updated ${editForm.firstName} ${editForm.lastName}.`)
      closeEdit()
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
        {selectedEditUser && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h3>Edit {selectedEditUser.firstName} {selectedEditUser.lastName}</h3>
            <div className="two-col">
              <div className="field">
                <label>First name</label>
                <input
                  value={editForm.firstName}
                  onChange={(e) => setEditForm((f) => ({ ...f, firstName: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Last name</label>
                <input
                  value={editForm.lastName}
                  onChange={(e) => setEditForm((f) => ({ ...f, lastName: e.target.value }))}
                />
              </div>
            </div>
            <div className="two-col">
              <div className="field">
                <label>Phone number</label>
                <input
                  value={editForm.phoneNumber}
                  onChange={(e) => setEditForm((f) => ({ ...f, phoneNumber: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Role</label>
                <select
                  value={editForm.role}
                  onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value }))}
                >
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <button className="btn btn-primary btn-sm" onClick={saveEdit}>Save changes</button>
              <button className="btn btn-link btn-sm" style={{ marginLeft: 8 }} onClick={closeEdit}>Cancel</button>
            </div>
          </div>
        )}
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : members.length === 0 ? (
          <div className="empty-state">No team members yet.</div>
        ) : (
          <div>
            <table className="ledger">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Merchant</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>{m.firstName} {m.lastName}</td>
                    <td className="mono">{m.email}</td>
                    <td>{ROLE_LABELS[m.role] || m.role}</td>
                    <td>{m.merchantId ? ((merchants.find((x) => x.id === m.merchantId) || {}).displayName || '—') : <em>Tenant-level</em>}</td>
                    <td><span className={`status-pill ${m.isActive ? 'approved' : 'rejected'}`}>{m.isActive ? 'Active' : 'Inactive'}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canManage && m.id !== user.id ? (
                        <>
                          <button className="btn btn-link btn-sm" onClick={() => openEdit(m)} style={{ marginRight: 6 }}>
                            Edit
                          </button>
                          <button className="btn btn-link btn-sm" onClick={() => toggleActive(m)} style={{ marginRight: 6 }}>
                            {m.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                          {user.role === 'TENANT_ADMIN' && (
                            <button className="btn btn-link btn-sm" onClick={() => { setSelectedUser(m); loadPermissionsFor(m.id) }}>
                              Permissions
                            </button>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Merchant assignment section */}
            {canManage && (
              <div style={{ marginTop: 16, padding: 16, backgroundColor: '#f9f9f9', borderRadius: 4 }}>
                <h3>Assign Merchants to Team Members</h3>
                <div style={{ marginTop: 12 }}>
                  <div className="field" style={{ marginBottom: 12 }}>
                    <label>Select a team member:</label>
                    <select
                      value={merchantAssignmentUser?.id || ''}
                      onChange={(e) => setMerchantAssignmentUser(members.find(m => m.id === e.target.value) || null)}
                    >
                      <option value="">Choose a team member…</option>
                      {members.filter(m => m.id !== user.id).map((m) => (
                        <option key={m.id} value={m.id}>{m.firstName} {m.lastName}</option>
                      ))}
                    </select>
                  </div>
                  {merchantAssignmentUser && (
                    <div className="field">
                      <label>Assign merchant for {merchantAssignmentUser.firstName} {merchantAssignmentUser.lastName}:</label>
                      <select
                        value={merchantAssignmentUser.merchantId || ''}
                        onChange={(e) => changeMerchant(merchantAssignmentUser, e.target.value || null)}
                      >
                        <option value="">Tenant-level (no merchant)</option>
                        {merchants.map((mm) => (
                          <option key={mm.id} value={mm.id}>{mm.displayName}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </div>
            )}
            {/* Permissions management section */}
            {user.role === 'TENANT_ADMIN' && selectedUser && (
              <div className="card" style={{ marginTop: 16 }}>
                <h3>Permissions for {selectedUser.firstName} {selectedUser.lastName}</h3>
                <p style={{ marginBottom: 16, fontSize: 14, color: '#666' }}>
                  <strong>Role:</strong> {selectedUser.role} | <strong>Default permissions:</strong> {getDefaultPermissionsForRole(selectedUser.role).length}
                </p>
                
                {/* Role-based default permissions */}
                <div style={{ marginBottom: 20 }}>
                  <h4 style={{ marginTop: 0, marginBottom: 12 }}>Role-Based Default Permissions</h4>
                  <div style={{ padding: 12, backgroundColor: '#f0f8ff', borderRadius: 4, border: '1px solid #cce7ff' }}>
                    {getDefaultPermissionsForRole(selectedUser.role).length === 0 ? (
                      <p style={{ margin: 0, color: '#666' }}>No default permissions for this role</p>
                    ) : (
                      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {getDefaultPermissionsForRole(selectedUser.role).map((perm) => (
                          <li key={perm} style={{ padding: 6, fontSize: 14 }}>
                            <span style={{ color: '#28a745' }}>✓</span> {getPermissionLabel(perm)}
                            <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>{getPermissionDescription(perm)}</div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
                
                {/* Additional custom permissions */}
                <div style={{ marginBottom: 20 }}>
                  <h4 style={{ marginTop: 0, marginBottom: 12 }}>Additional Custom Permissions</h4>
                  {selectedUserPermissions.length === 0 ? (
                    <div className="empty-state">No additional permissions granted.</div>
                  ) : (
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                      {selectedUserPermissions.map((p) => (
                        <li key={p.id} style={{ padding: 12, borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div>
                            <strong>{getPermissionLabel(p.permissionType)}</strong>
                            {p.resourceId && (
                              <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                                📍 {merchants.find(m => m.id === p.resourceId)?.displayName || 'Unknown Merchant'}
                              </div>
                            )}
                            {!p.resourceId && (
                              <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                                🌐 Tenant-wide permission
                              </div>
                            )}
                          </div>
                          <button
                            className="btn btn-link btn-sm"
                            onClick={() => {
                              console.log('Revoking permission:', p.id, 'for user:', selectedUser.id)
                              operatorApi.revokePermission(selectedUser.id, p.id)
                                .then(() => {
                                  console.log('Permission revoked successfully')
                                  loadPermissionsFor(selectedUser.id)
                                })
                                .catch((e) => {
                                  console.error('Error revoking permission:', e)
                                  setError(e.message)
                                })
                            }}
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                
                {/* Grant new permission */}
                <div style={{ padding: 12, backgroundColor: '#f9f9f9', borderRadius: 4 }}>
                  <h4 style={{ marginTop: 0 }}>Grant Additional Permission</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, alignItems: 'flex-end' }}>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label>Permission Type</label>
                      <select
                        value={newPermissionType}
                        onChange={(e) => setNewPermissionType(e.target.value)}
                      >
                        <option value="">Select a permission…</option>
                        {Object.entries(PERMISSION_TYPES).map(([key, value]) => (
                          <option key={value} value={value}>{getPermissionLabel(value)}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label>Scope (optional)</label>
                      <select
                        value={newPermissionResource}
                        onChange={(e) => setNewPermissionResource(e.target.value)}
                      >
                        <option value="">Tenant-wide</option>
                        {merchants.map((mm) => (
                          <option key={mm.id} value={mm.id}>{mm.displayName}</option>
                        ))}
                      </select>
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        if (!newPermissionType) {
                          setError('Please select a permission type')
                          return
                        }
                        console.log('Granting permission:', newPermissionType, 'resource:', newPermissionResource, 'to user:', selectedUser.id)
                        operatorApi.grantPermission(selectedUser.id, {
                          permissionType: newPermissionType,
                          resourceId: newPermissionResource || null
                        })
                          .then((result) => {
                            console.log('Permission granted successfully:', result)
                            setNotice(`Permission "${getPermissionLabel(newPermissionType)}" granted`)
                            setNewPermissionType('')
                            setNewPermissionResource('')
                            loadPermissionsFor(selectedUser.id)
                          })
                          .catch((e) => {
                            console.error('Error granting permission:', e)
                            setError(e.message)
                          })
                      }}
                    >
                      Grant
                    </button>
                  </div>
                  {newPermissionType && (
                    <div style={{ marginTop: 12, padding: 10, backgroundColor: '#fff', borderRadius: 3, fontSize: 13, color: '#666' }}>
                      <strong>Description:</strong> {getPermissionDescription(newPermissionType)}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
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
          <div className="two-col">
            <div className="field">
              <label>Assign to merchant</label>
              <select value={form.merchantId || ''} onChange={(e) => setForm((f) => ({ ...f, merchantId: e.target.value || '' }))}>
                <option value="">Tenant-level (no merchant)</option>
                {merchants.map((mm) => (
                  <option key={mm.id} value={mm.id}>{mm.displayName}</option>
                ))}
              </select>
            </div>
            <div className="field" />
          </div>
          <button className="btn btn-primary" disabled={creating}>{creating ? 'Adding…' : 'Add team member'}</button>
        </form>
      )}
    </div>
  )
}
