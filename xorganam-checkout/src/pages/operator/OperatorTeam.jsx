import { useEffect, useState } from 'react'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'
import { PERMISSION_TYPES, PERMISSION_LABELS, getPermissionLabel, getPermissionDescription, getDefaultPermissionsForRole } from '../../constants/permissions'

const ROLES = [
  { value: 'TENANT_ADMIN', label: 'Admin — full control, including team management' },
  { value: 'TENANT_MANAGER', label: 'Manager — merchants, transactions, team' },
  { value: 'TENANT_BRANCH_MANAGER', label: 'Branch manager — assigned branch only' },
  { value: 'TENANT_OPERATOR', label: 'Operator — initiate collections and payouts' },
  { value: 'TENANT_VIEWER', label: 'Viewer — read-only' }
]

const ROLE_LABELS = Object.fromEntries(ROLES.map((r) => [r.value, r.label.split(' — ')[0]]))

const initialForm = {
  firstName: '',
  lastName: '',
  email: '',
  phoneNumber: '',
  role: 'TENANT_OPERATOR',
  merchantId: ''
}

export default function OperatorTeam() {
  const { user, hasPermission } = useOperatorAuth()
  const canManage = hasPermission('MANAGE_TEAM', user?.merchantId || null)

  const [members, setMembers] = useState([])
  const [merchants, setMerchants] = useState([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)

  const [form, setForm] = useState(initialForm)
  const [creating, setCreating] = useState(false)
  const [selectedUser, setSelectedUser] = useState(null)
  const [selectedUserPermissions, setSelectedUserPermissions] = useState([])
  const [permissionHistory, setPermissionHistory] = useState([])
  const [permissionHistoryLoading, setPermissionHistoryLoading] = useState(false)
  const [permissionHistoryError, setPermissionHistoryError] = useState('')
  const [newPermissionType, setNewPermissionType] = useState('')
  const [newPermissionResource, setNewPermissionResource] = useState('')
  const [newPermissionExpiresAt, setNewPermissionExpiresAt] = useState('')
  const [bulkPermissionUserIds, setBulkPermissionUserIds] = useState([])
  const [bulkPermissionBusy, setBulkPermissionBusy] = useState(false)
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
      if (!operatorApi.listUserPermissions || !operatorApi.listUserPermissionHistory) {
        setError('Permission management is unavailable in this version.')
        setSelectedUserPermissions([])
        setPermissionHistory([])
        return
      }
      setPermissionHistoryError('')
      setPermissionHistoryLoading(true)
      const [perms, history] = await Promise.all([
        operatorApi.listUserPermissions(userId),
        operatorApi.listUserPermissionHistory(userId)
      ])
      setSelectedUserPermissions(perms || [])
      setPermissionHistory(history || [])
    } catch (err) {
      setPermissionHistoryError(`Failed to load permission history: ${err.message}`)
      setSelectedUserPermissions([])
      setPermissionHistory([])
    } finally {
      setPermissionHistoryLoading(false)
    }
  }

  async function handleCreate(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    setCreating(true)
    try {
      const result = await operatorApi.createUser({ tenantId: user.tenantId, ...form })
      const verificationStatus = result.emailVerificationSent ? 'verification email sent' : 'verification email not delivered'
      const setupStatus = result.passwordSetupSent ? 'password setup email sent' : 'password setup email not delivered'
      setNotice(`${form.firstName} ${form.lastName} added; ${verificationStatus}; ${setupStatus}.`)
      if (!result.emailVerificationSent || !result.passwordSetupSent) {
        setError('The account was created, but one or more emails were not delivered. Configure email delivery or ask the new user to request the missing link.')
      }
      setForm(initialForm)
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setCreating(false)
    }
  }

  async function toggleActive(member) {
    const willActivate = !member.isActive
    if (!window.confirm(`${willActivate ? 'Activate' : 'Deactivate'} ${member.firstName} ${member.lastName}? They will ${willActivate ? 'be able to sign in again' : 'lose access immediately'}.`)) return
    setError('')
    setNotice('')
    try {
      await operatorApi.updateUserStatus(member.id, willActivate, member.merchantId)
      setNotice(`${member.firstName} ${member.lastName} ${willActivate ? 'activated' : 'deactivated'}.`)
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
        merchantId: selectedEditUser.merchantId,
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

  async function grantPermissionBulk() {
    if (!newPermissionType || !bulkPermissionUserIds.length) {
      setError('Select a permission and at least one team member.')
      return
    }
    const expiryTimestamp = newPermissionExpiresAt ? new Date(newPermissionExpiresAt) : null
    if (expiryTimestamp && (!Number.isFinite(expiryTimestamp.getTime()) || expiryTimestamp.getTime() <= Date.now())) {
      setError('Permission expiry must be a future date and time.')
      return
    }
    if (!window.confirm(`Grant ${getPermissionLabel(newPermissionType)} to ${bulkPermissionUserIds.length} team members?`)) return

    setError('')
    setNotice('')
    setBulkPermissionBusy(true)
    try {
      const result = await operatorApi.grantPermissionBulk({
        tenantId: user.tenantId,
        userIds: bulkPermissionUserIds,
        permissionType: newPermissionType,
        resourceId: newPermissionResource || null,
        expiresAt: expiryTimestamp?.toISOString() || null
      })
      setNotice(`Bulk permission update: ${result.granted} granted, ${result.renewed} renewed, ${result.alreadyActive} already active.`)
      setBulkPermissionUserIds([])
      setNewPermissionType('')
      setNewPermissionResource('')
      setNewPermissionExpiresAt('')
      if (selectedUser) loadPermissionsFor(selectedUser.id)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBulkPermissionBusy(false)
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

      {error && <div className="status-banner error" role="alert"><span className="status-icon">⚠</span><span>{error}</span></div>}
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
                <label htmlFor="edit-first-name">First name</label>
                <input
                  id="edit-first-name"
                  value={editForm.firstName}
                  onChange={(e) => setEditForm((f) => ({ ...f, firstName: e.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="edit-last-name">Last name</label>
                <input
                  id="edit-last-name"
                  value={editForm.lastName}
                  onChange={(e) => setEditForm((f) => ({ ...f, lastName: e.target.value }))}
                />
              </div>
            </div>
            <div className="two-col">
              <div className="field">
                <label htmlFor="edit-phone-number">Phone number</label>
                <input
                  id="edit-phone-number"
                  value={editForm.phoneNumber}
                  onChange={(e) => setEditForm((f) => ({ ...f, phoneNumber: e.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="edit-role">Role</label>
                <select
                  id="edit-role"
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
                  {user.role === 'TENANT_ADMIN' && <th scope="col">Bulk grant</th>}
                  <th>Name</th>
                  <th>Email</th>
                  <th>Email verification</th>
                  <th>Role</th>
                  <th>Merchant</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    {user.role === 'TENANT_ADMIN' && <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${m.firstName} ${m.lastName} for bulk permission grant`}
                        checked={bulkPermissionUserIds.includes(m.id)}
                        disabled={m.id === user.id || bulkPermissionBusy}
                        onChange={(event) => setBulkPermissionUserIds((current) => {
                          if (event.target.checked) {
                            if (current.length >= 100) {
                              setError('Bulk permission grants are limited to 100 users per request.')
                              return current
                            }
                            return [...current, m.id]
                          }
                          return current.filter((id) => id !== m.id)
                        })}
                      />
                    </td>}
                    <td>{m.firstName} {m.lastName}</td>
                    <td className="mono">{m.email}</td>
                    <td><span className={`status-pill ${m.emailVerifiedAt ? 'approved' : 'pending'}`}>{m.emailVerifiedAt ? 'Verified' : 'Pending verification'}</span></td>
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
            {user.role === 'TENANT_ADMIN' && bulkPermissionUserIds.length > 0 && (
              <section className="card" aria-label="Bulk permission grant" style={{ marginTop: 16 }}>
                <h3>Grant one permission to {bulkPermissionUserIds.length} team members</h3>
                <div className="two-col">
                  <div className="field">
                    <label htmlFor="bulk-permission-type">Permission</label>
                    <select id="bulk-permission-type" value={newPermissionType} onChange={(event) => setNewPermissionType(event.target.value)}>
                      <option value="">Select a permission…</option>
                      {Object.values(PERMISSION_TYPES).map((permissionType) => (
                        <option key={permissionType} value={permissionType}>{getPermissionLabel(permissionType)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="bulk-permission-scope">Merchant scope</label>
                    <select id="bulk-permission-scope" value={newPermissionResource} onChange={(event) => setNewPermissionResource(event.target.value)}>
                      <option value="">Tenant-wide</option>
                      {merchants.map((merchant) => <option key={merchant.id} value={merchant.id}>{merchant.displayName}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="bulk-permission-expiry">Expires (optional)</label>
                    <input id="bulk-permission-expiry" type="datetime-local" value={newPermissionExpiresAt} onChange={(event) => setNewPermissionExpiresAt(event.target.value)} />
                  </div>
                </div>
                <button className="btn btn-primary" type="button" disabled={bulkPermissionBusy} onClick={grantPermissionBulk}>
                  {bulkPermissionBusy ? 'Applying…' : 'Grant to selected'}
                </button>
                <button className="btn btn-link" type="button" disabled={bulkPermissionBusy} onClick={() => setBulkPermissionUserIds([])}>Clear selection</button>
              </section>
            )}
            {/* Merchant assignment section */}
            {canManage && (
              <div style={{ marginTop: 16, padding: 16, backgroundColor: '#f9f9f9', borderRadius: 4 }}>
                <h3>Assign Merchants to Team Members</h3>
                <div style={{ marginTop: 12 }}>
                  <div className="field" style={{ marginBottom: 12 }}>
                    <label htmlFor="merchant-assignment-user">Select a team member:</label>
                    <select
                      id="merchant-assignment-user"
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
                      <label htmlFor="merchant-assignment">Assign merchant for {merchantAssignmentUser.firstName} {merchantAssignmentUser.lastName}:</label>
                      <select
                        id="merchant-assignment"
                        value={merchantAssignmentUser.merchantId || ''}
                        onChange={(e) => changeMerchant(merchantAssignmentUser, e.target.value || null)}
                      >
                        {!user.merchantId && <option value="">Tenant-level (no merchant)</option>}
                        {merchants.filter((mm) => !user.merchantId || String(mm.id) === String(user.merchantId)).map((mm) => (
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
                            <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                              {p.expiresAt ? `Expires ${new Date(p.expiresAt).toLocaleString()}` : 'No expiry'}
                            </div>
                          </div>
                          <button
                            className="btn btn-link btn-sm"
                            onClick={() => {
                              if (!window.confirm(`Revoke ${getPermissionLabel(p.permissionType)}${p.resourceId ? ' for this merchant' : ' tenant-wide'}? The user may lose access immediately.`)) return
                              operatorApi.revokePermission(selectedUser.id, p.id)
                                .then(() => {
                                  loadPermissionsFor(selectedUser.id)
                                })
                                .catch((e) => {
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

                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <h4 style={{ margin: 0 }}>Permission History</h4>
                    <button
                      className="btn btn-link btn-sm"
                      type="button"
                      onClick={() => loadPermissionsFor(selectedUser.id)}
                      disabled={permissionHistoryLoading}
                    >
                      {permissionHistoryLoading ? 'Refreshing…' : 'Refresh'}
                    </button>
                  </div>
                  {permissionHistoryLoading ? (
                    <div className="empty-state">Loading permission history…</div>
                  ) : permissionHistoryError ? (
                    <div className="empty-state" role="alert">
                      {permissionHistoryError}
                    </div>
                  ) : permissionHistory.length === 0 ? (
                    <div className="empty-state">No permission changes recorded.</div>
                  ) : (
                    <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                      {permissionHistory.map((event) => (
                        <li key={event.id} style={{ padding: '10px 0', borderBottom: '1px solid #eee' }}>
                          <strong>{event.action === 'permission.granted' ? 'Granted' : event.action === 'permission.renewed' ? 'Renewed' : 'Revoked'}</strong>
                          <span style={{ color: '#666' }}> — {event.permissionType ? getPermissionLabel(event.permissionType) : 'Permission'}</span>
                          <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                            {new Date(event.createdAt).toLocaleString()} · {event.resourceId ? 'Scoped permission' : 'Tenant-wide permission'} · {event.expiresAt ? `Expires ${new Date(event.expiresAt).toLocaleString()}` : 'No expiry'}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
                
                {/* Grant new permission */}
                <div style={{ padding: 12, backgroundColor: '#f9f9f9', borderRadius: 4 }}>
                  <h4 style={{ marginTop: 0 }}>Grant Additional Permission</h4>
                  <div className="bulk-permission-grid">
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label htmlFor="permission-type">Permission Type</label>
                      <select
                        id="permission-type"
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
                      <label htmlFor="permission-scope">Scope (optional)</label>
                      <select
                        id="permission-scope"
                        value={newPermissionResource}
                        onChange={(e) => setNewPermissionResource(e.target.value)}
                      >
                        <option value="">Tenant-wide</option>
                        {merchants.map((mm) => (
                          <option key={mm.id} value={mm.id}>{mm.displayName}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label htmlFor="permission-expires-at">Expires (optional)</label>
                      <input
                        id="permission-expires-at"
                        type="datetime-local"
                        value={newPermissionExpiresAt}
                        onChange={(event) => setNewPermissionExpiresAt(event.target.value)}
                      />
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        if (!newPermissionType) {
                          setError('Please select a permission type')
                          return
                        }
                        const expiryTimestamp = newPermissionExpiresAt ? new Date(newPermissionExpiresAt) : null
                        if (expiryTimestamp && (!Number.isFinite(expiryTimestamp.getTime()) || expiryTimestamp.getTime() <= Date.now())) {
                          setError('Permission expiry must be a future date and time.')
                          return
                        }
                        operatorApi.grantPermission(selectedUser.id, {
                          permissionType: newPermissionType,
                          resourceId: newPermissionResource || null,
                          expiresAt: expiryTimestamp?.toISOString() || null
                        })
                          .then(() => {
                            setNotice(`Permission "${getPermissionLabel(newPermissionType)}" granted`)
                            setNewPermissionType('')
                            setNewPermissionResource('')
                            setNewPermissionExpiresAt('')
                            loadPermissionsFor(selectedUser.id)
                          })
                          .catch((e) => {
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
              <label htmlFor="new-first-name">First name</label>
              <input id="new-first-name" required value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="new-last-name">Last name</label>
              <input id="new-last-name" required value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} />
            </div>
          </div>
          <div className="two-col">
            <div className="field">
              <label htmlFor="new-email">Email</label>
              <input id="new-email" required type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="new-phone-number">Phone number</label>
              <input id="new-phone-number" value={form.phoneNumber} onChange={(e) => setForm((f) => ({ ...f, phoneNumber: e.target.value }))} placeholder="0551234567" />
            </div>
          </div>
          <div className="two-col">
            <div className="field">
              <label htmlFor="new-role">Role</label>
              <select id="new-role" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="two-col">
            <div className="field">
              <label htmlFor="new-merchant">Assign to merchant</label>
              <select id="new-merchant" required={form.role === 'TENANT_BRANCH_MANAGER'} value={form.merchantId || ''} onChange={(e) => setForm((f) => ({ ...f, merchantId: e.target.value || '' }))}>
                {!user.merchantId && <option value="">Tenant-level (no merchant)</option>}
                {merchants.filter((mm) => !user.merchantId || String(mm.id) === String(user.merchantId)).map((mm) => (
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
