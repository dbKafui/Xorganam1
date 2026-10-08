import { useCallback, useEffect, useState } from 'react'
import { institutionApi } from '../api/client.js'
import { useInstitutionAuth } from '../context/InstitutionAuthContext.jsx'
import PageHeader from '../components/PageHeader.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import { EmptyState, ErrorMessage, LoadingState, SuccessMessage } from '../components/Feedback.jsx'

const emptyProfile = {
  name: '',
  settlementMsisdn: '',
  settlementAccountName: '',
  settlementCountryCode: '',
  verificationSlaHours: 48,
  apiVerificationSupported: false,
  status: 'ACTIVE'
}
const emptyBranch = { name: '', code: '', address: '', eganowSettlementAccountRef: '' }

function profileToForm(profile) {
  return {
    name: profile.name || '',
    settlementMsisdn: profile.settlement_msisdn || '',
    settlementAccountName: profile.settlement_account_name || '',
    settlementCountryCode: profile.settlement_country_code || '',
    verificationSlaHours: profile.verification_sla_hours || 48,
    apiVerificationSupported: Boolean(profile.api_verification_supported),
    status: profile.status || 'ACTIVE'
  }
}

export default function InstitutionProfile() {
  const { staff } = useInstitutionAuth()
  const [profile, setProfile] = useState(emptyProfile)
  const [branches, setBranches] = useState([])
  const [branchForm, setBranchForm] = useState(emptyBranch)
  const [editingBranchId, setEditingBranchId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const canManage = staff?.role === 'INSTITUTION_ADMIN'

  const load = useCallback(async () => {
    const [institution, branchRows] = await Promise.all([
      institutionApi.getInstitutionProfile(),
      institutionApi.listBranches()
    ])
    setProfile(profileToForm(institution))
    setBranches(Array.isArray(branchRows) ? branchRows : [])
  }, [])

  useEffect(() => {
    load().catch((requestError) => setError(requestError.message)).finally(() => setLoading(false))
  }, [load])

  async function saveProfile(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setSaving(true)
    try {
      const result = await institutionApi.updateInstitutionProfile({
        ...profile,
        verificationSlaHours: Number(profile.verificationSlaHours)
      })
      setProfile(profileToForm(result))
      setNotice('Institution profile saved.')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  function editBranch(branch) {
    setEditingBranchId(branch.id)
    setBranchForm({
      name: branch.name || '',
      code: branch.code || '',
      address: branch.address || '',
      eganowSettlementAccountRef: branch.eganow_settlement_account_ref || ''
    })
  }

  function cancelBranchEdit() {
    setEditingBranchId('')
    setBranchForm(emptyBranch)
  }

  async function saveBranch(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setSaving(true)
    try {
      if (editingBranchId) await institutionApi.updateBranch(editingBranchId, branchForm)
      else await institutionApi.createBranch(branchForm)
      setNotice(editingBranchId ? 'Branch details saved.' : 'Branch created.')
      cancelBranchEdit()
      await load()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  async function toggleBranch(branch) {
    const willActivate = !branch.is_active
    if (!window.confirm(`${willActivate ? 'Activate' : 'Deactivate'} ${branch.name}? ${willActivate ? 'The branch will become available for new activity.' : 'Existing staff assignments must be resolved first.'}`)) return
    setError('')
    setNotice('')
    setSaving(true)
    try {
      await institutionApi.updateBranch(branch.id, { isActive: willActivate })
      setNotice(`Branch ${branch.is_active ? 'deactivated' : 'activated'}.`)
      await load()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <><PageHeader eyebrow="INSTITUTION / PROFILE" title="Institution profile" description="Manage institution details, verification timing, and branch records." /><LoadingState /></>

  return (
    <>
      <PageHeader eyebrow="INSTITUTION / PROFILE" title="Institution profile" description="Manage institution details, verification timing, and branch records." />
      <ErrorMessage>{error}</ErrorMessage>
      <SuccessMessage>{notice}</SuccessMessage>
      <section className="surface settings-surface">
        <div className="section-head"><div><div className="eyebrow">INSTITUTION DETAILS</div><h2>Profile and verification SLA</h2></div><StatusBadge value={profile.status || 'ACTIVE'} /></div>
        <form className="form-grid" onSubmit={saveProfile}>
          <label className="form-field"><span>Institution name</span><input required maxLength="160" disabled={!canManage} value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} /></label>
          <label className="form-field"><span>Settlement account name</span><input disabled={!canManage} value={profile.settlementAccountName} onChange={(event) => setProfile({ ...profile, settlementAccountName: event.target.value })} /></label>
          <label className="form-field"><span>Settlement MSISDN</span><input disabled={!canManage} value={profile.settlementMsisdn} onChange={(event) => setProfile({ ...profile, settlementMsisdn: event.target.value })} /></label>
          <label className="form-field"><span>Settlement country code</span><input disabled={!canManage} value={profile.settlementCountryCode} onChange={(event) => setProfile({ ...profile, settlementCountryCode: event.target.value })} /></label>
          <label className="form-field"><span>Verification SLA (hours)</span><input type="number" min="1" max="8760" required disabled={!canManage} value={profile.verificationSlaHours} onChange={(event) => setProfile({ ...profile, verificationSlaHours: event.target.value })} /></label>
          <label className="checkbox-field form-span"><input type="checkbox" disabled={!canManage} checked={profile.apiVerificationSupported} onChange={(event) => setProfile({ ...profile, apiVerificationSupported: event.target.checked })} /><span>Enable API-based membership verification</span></label>
          {canManage && <div className="form-span form-actions"><button className="button button-primary" disabled={saving}>{saving ? 'Saving...' : 'Save profile'} <span>→</span></button></div>}
        </form>
      </section>

      <section className="surface">
        <div className="section-head"><div><div className="eyebrow">BRANCH DIRECTORY</div><h2>Branches</h2></div><span className="count-pill">{branches.length}</span></div>
        {branches.length ? <div className="table-wrap"><table>
          <thead><tr><th>Branch</th><th>Code / address</th><th>Settlement reference</th><th>Staff</th><th>Status</th>{canManage && <th>Actions</th>}</tr></thead>
          <tbody>{branches.map((branch) => (
            <tr key={branch.id}>
              <td><strong>{branch.name}</strong></td>
              <td>{branch.code || '—'}<small>{branch.address || 'No address'}</small></td>
              <td className="mono">{branch.eganow_settlement_account_ref || '—'}</td>
              <td>{branch.staff_count}</td>
              <td><StatusBadge value={branch.is_active ? 'ACTIVE' : 'INACTIVE'} /></td>
              {canManage && <td className="action-cell">
                <button className="button button-secondary button-small" disabled={saving} onClick={() => editBranch(branch)}>Edit</button>
                <button className="button button-secondary button-small" disabled={saving || (branch.is_active && Number(branch.staff_count) > 0)} onClick={() => toggleBranch(branch)}>
                  {branch.is_active ? 'Deactivate' : 'Activate'}
                </button>
              </td>}
            </tr>
          ))}</tbody>
        </table></div> : <EmptyState title="No branches">Add the first branch below.</EmptyState>}
      </section>

      {canManage && <section className="surface form-surface">
        <div className="eyebrow">{editingBranchId ? 'EDIT BRANCH' : 'NEW BRANCH'}</div>
        <h2>{editingBranchId ? 'Update branch details' : 'Add a branch'}</h2>
        <form className="form-grid" onSubmit={saveBranch}>
          <label className="form-field"><span>Branch name</span><input required maxLength="160" value={branchForm.name} onChange={(event) => setBranchForm({ ...branchForm, name: event.target.value })} /></label>
          <label className="form-field"><span>Branch code</span><input value={branchForm.code} onChange={(event) => setBranchForm({ ...branchForm, code: event.target.value })} /></label>
          <label className="form-field form-span"><span>Address</span><input value={branchForm.address} onChange={(event) => setBranchForm({ ...branchForm, address: event.target.value })} /></label>
          <label className="form-field form-span"><span>Eganow settlement account reference</span><input value={branchForm.eganowSettlementAccountRef} onChange={(event) => setBranchForm({ ...branchForm, eganowSettlementAccountRef: event.target.value })} /></label>
          <div className="form-span form-actions">
            {editingBranchId && <button type="button" className="button button-secondary" onClick={cancelBranchEdit}>Cancel</button>}
            <button className="button button-primary" disabled={saving}>{saving ? 'Saving...' : editingBranchId ? 'Save branch' : 'Create branch'} <span>→</span></button>
          </div>
        </form>
        <p className="footnote">A branch with active staff cannot be deactivated until its staff have been reassigned.</p>
      </section>}
    </>
  )
}