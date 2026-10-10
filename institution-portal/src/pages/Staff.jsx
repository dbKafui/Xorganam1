import { Fragment, useCallback, useEffect, useState } from 'react'
import { institutionApi } from '../api/client.js'
import { useInstitutionAuth } from '../context/InstitutionAuthContext.jsx'
import PageHeader from '../components/PageHeader.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import { EmptyState, ErrorMessage, LoadingState, SuccessMessage } from '../components/Feedback.jsx'

export default function Staff() {
  const { staff: currentStaff } = useInstitutionAuth()
  const [staff, setStaff] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', password: '', role: 'FIELD_OFFICER', branchId: '' })
  const [branches, setBranches] = useState([])
  const [editingStaffId, setEditingStaffId] = useState('')
  const [editForm, setEditForm] = useState({ role: 'FIELD_OFFICER', branchId: '', isActive: true })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const canManage = currentStaff?.role === 'INSTITUTION_ADMIN'

  const load = useCallback(async () => {
    const [staffRows, branchRows] = await Promise.all([institutionApi.listStaff(), institutionApi.listBranches()])
    setStaff(Array.isArray(staffRows) ? staffRows : [])
    setBranches(Array.isArray(branchRows) ? branchRows : [])
  }, [])
  useEffect(() => {
    load().catch((requestError) => setError(requestError.message)).finally(() => setLoading(false))
  }, [load])

  async function submit(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setSaving(true)
    try {
      await institutionApi.createStaff(form)
      setForm({ firstName: '', lastName: '', email: '', password: '', role: 'FIELD_OFFICER', branchId: '' })
      setShowForm(false)
      setNotice('Staff account created.')
      await load()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  function startEdit(person) {
    setEditingStaffId(person.id)
    setEditForm({ role: person.role, branchId: person.branch_id || '', isActive: person.is_active, deactivationReason: '' })
  }

  async function saveAccess(person) {
    setError('')
    setNotice('')
    setSaving(true)
    try {
      await institutionApi.updateStaff(person.id, {
        role: editForm.role,
        branchId: editForm.branchId || null,
        isActive: editForm.isActive,
        deactivationReason: editForm.deactivationReason
      })
      setNotice(`Access updated for ${person.first_name} ${person.last_name}.`)
      setEditingStaffId('')
      await load()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  async function makeReferralCode(person) {
    setError('')
    try {
      await institutionApi.generateReferralCode(person.id)
      setNotice(`Referral code updated for ${person.first_name} ${person.last_name}.`)
      await load()
    } catch (requestError) { setError(requestError.message) }
  }

  return (
    <>
      <PageHeader eyebrow="TEAM / DIRECTORY" title="Institution staff" description="Manage staff accounts and review current access levels." action={canManage && <button className="button button-primary" onClick={() => setShowForm((value) => !value)}>{showForm ? 'Close form' : '+ Add staff member'}</button>} />
      <ErrorMessage>{error}</ErrorMessage><SuccessMessage>{notice}</SuccessMessage>
      {showForm && canManage && <section className="surface form-surface">
        <div className="eyebrow">CREATE STAFF ACCOUNT</div><h2>New institution staff</h2>
        <form onSubmit={submit} className="form-grid">
          <label className="form-field"><span>First name</span><input required value={form.firstName} onChange={(event) => setForm({ ...form, firstName: event.target.value })} /></label>
          <label className="form-field"><span>Last name</span><input required value={form.lastName} onChange={(event) => setForm({ ...form, lastName: event.target.value })} /></label>
          <label className="form-field"><span>Email</span><input required type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
          <label className="form-field"><span>Temporary password</span><input required type="password" minLength="12" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /><small>Use at least 12 characters.</small></label>
          <label className="form-field"><span>Role</span><select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}><option value="FIELD_OFFICER">Field Officer</option><option value="SUPERVISOR">Supervisor</option><option value="INSTITUTION_ADMIN">Institution Admin</option></select></label>
          <label className="form-field"><span>Branch</span><select value={form.branchId} onChange={(event) => setForm({ ...form, branchId: event.target.value })}><option value="">No branch assigned</option>{branches.filter((branch) => branch.is_active).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
          <div className="form-actions"><button className="button button-primary" disabled={saving}>{saving ? 'Creating...' : 'Create account'}</button></div>
        </form>
      </section>}
      <section className="surface">
        <div className="section-head"><div><div className="eyebrow">DIRECTORY</div><h2>Staff accounts</h2></div><span className="count-pill">{staff.length} members</span></div>
        {loading ? <LoadingState /> : staff.length ? <div className="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Branch</th><th>Role</th><th>Referral</th><th>Status</th><th>Added</th>{canManage && <th>Access</th>}</tr></thead><tbody>
          {staff.map((person) => <Fragment key={person.id}>
            <tr><td><strong>{person.first_name} {person.last_name}</strong>{person.id === currentStaff?.id && <small>You</small>}</td><td>{person.email}</td><td>{person.branch_name || '—'}</td><td>{String(person.role).replaceAll('_', ' ')}</td><td>{person.role === 'FIELD_OFFICER' && <>{person.referral_code || 'Not set'} {person.referral_code && <small>https://app.xorganam.com/?institution={encodeURIComponent(currentStaff.institutionId)}&amp;ref={encodeURIComponent(person.referral_code)}</small>} {canManage && <button className="button button-secondary" onClick={() => makeReferralCode(person)}>{person.referral_code ? 'Regenerate' : 'Generate code'}</button>}</>}</td><td><StatusBadge value={person.is_active ? 'ACTIVE' : 'INACTIVE'} /></td><td>{new Date(person.created_at).toLocaleDateString()}</td>{canManage && <td><button className="button button-secondary button-small" onClick={() => startEdit(person)}>{editingStaffId === person.id ? 'Close' : 'Edit access'}</button></td>}</tr>
            {canManage && editingStaffId === person.id && <tr><td colSpan="8"><div className="review-actions">
              <label>Role<select value={editForm.role} onChange={(event) => setEditForm({ ...editForm, role: event.target.value })}><option value="FIELD_OFFICER">Field Officer</option><option value="SUPERVISOR">Supervisor</option><option value="INSTITUTION_ADMIN">Institution Admin</option></select></label>
              <label>Branch<select value={editForm.branchId} onChange={(event) => setEditForm({ ...editForm, branchId: event.target.value })}><option value="">No branch assigned</option>{branches.filter((branch) => branch.is_active).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
              <label className="checkbox-field"><input type="checkbox" checked={editForm.isActive} onChange={(event) => setEditForm({ ...editForm, isActive: event.target.checked })} /><span>Active</span></label>
              {!editForm.isActive && <label>Reason for deactivation<textarea required minLength="5" maxLength="1000" value={editForm.deactivationReason} onChange={(event) => setEditForm({ ...editForm, deactivationReason: event.target.value })} /></label>}
              <button type="button" className="button button-primary button-small" disabled={saving} onClick={() => saveAccess(person)}>{saving ? 'Saving...' : 'Save access'}</button>
            </div></td></tr>}
          </Fragment>)}
        </tbody></table></div> : <EmptyState title="No staff records">Staff accounts will appear here.</EmptyState>}
      </section>
    </>
  )
}
