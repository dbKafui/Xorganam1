import { useCallback, useEffect, useMemo, useState } from 'react'
import { institutionApi } from '../api/client.js'
import { useInstitutionAuth } from '../context/InstitutionAuthContext.jsx'
import PageHeader from '../components/PageHeader.jsx'
import { EmptyState, ErrorMessage, LoadingState, SuccessMessage } from '../components/Feedback.jsx'

export default function TeamStructure() {
  const { staff: currentStaff } = useInstitutionAuth()
  const [staff, setStaff] = useState([])
  const [hierarchy, setHierarchy] = useState([])
  const [fieldOfficerStaffId, setFieldOfficerStaffId] = useState('')
  const [supervisorStaffId, setSupervisorStaffId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const [staffRows, hierarchyRows] = await Promise.all([
      institutionApi.listStaff(),
      institutionApi.listHierarchy()
    ])
    setStaff(Array.isArray(staffRows) ? staffRows : [])
    setHierarchy(Array.isArray(hierarchyRows) ? hierarchyRows : [])
  }, [])

  useEffect(() => {
    load().catch((requestError) => setError(requestError.message)).finally(() => setLoading(false))
  }, [load])

  const officers = useMemo(
    () => staff.filter((person) => person.role === 'FIELD_OFFICER' && person.is_active),
    [staff]
  )
  const supervisors = useMemo(
    () => staff.filter((person) => person.role === 'SUPERVISOR' && person.is_active),
    [staff]
  )

  async function submit(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setSaving(true)
    try {
      await institutionApi.saveHierarchy({ fieldOfficerStaffId, supervisorStaffId })
      setNotice('Supervisor relationship saved. The previous relationship remains in the history.')
      setFieldOfficerStaffId('')
      if (currentStaff?.role === 'SUPERVISOR') setSupervisorStaffId(currentStaff.id)
      else setSupervisorStaffId('')
      await load()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageHeader eyebrow="TEAM / REPORTING" title="Team structure" description="Assign each field officer to an active supervisor. Changes are recorded as effective-dated history." />
      <ErrorMessage>{error}</ErrorMessage>
      <SuccessMessage>{notice}</SuccessMessage>
      <div className="content-grid assignment-grid">
        <section className="surface">
          <div className="eyebrow">REPORTING LINE</div>
          <h2>Set a supervisor</h2>
          <form onSubmit={submit} className="form-stack">
            <label className="form-field">
              <span>Field officer</span>
              <select required value={fieldOfficerStaffId} onChange={(event) => setFieldOfficerStaffId(event.target.value)}>
                <option value="">Select field officer</option>
                {officers.map((person) => <option key={person.id} value={person.id}>{person.first_name} {person.last_name}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span>Supervisor</span>
              <select
                required
                value={supervisorStaffId}
                onChange={(event) => setSupervisorStaffId(event.target.value)}
                disabled={currentStaff?.role === 'SUPERVISOR'}
              >
                <option value="">Select supervisor</option>
                {supervisors.map((person) => <option key={person.id} value={person.id}>{person.first_name} {person.last_name}</option>)}
              </select>
            </label>
            <button className="button button-primary" disabled={saving || !officers.length || !supervisors.length}>
              {saving ? 'Saving...' : 'Save reporting line'} <span>→</span>
            </button>
          </form>
          {(!officers.length || !supervisors.length) && <p className="inline-hint">Create active field officer and supervisor accounts before assigning reporting lines.</p>}
        </section>
        <section className="surface">
          <div className="section-head">
            <div><div className="eyebrow">EFFECTIVE-DATED RECORDS</div><h2>Reporting history</h2></div>
            <span className="count-pill">{hierarchy.length}</span>
          </div>
          {loading ? <LoadingState /> : hierarchy.length ? (
            <div className="table-wrap"><table>
              <thead><tr><th>Field officer</th><th>Supervisor</th><th>Effective from</th><th>Effective to</th></tr></thead>
              <tbody>{hierarchy.map((row) => (
                <tr key={row.id}>
                  <td>{row.field_officer_name || row.field_officer_staff_id}</td>
                  <td>{row.supervisor_name || row.supervisor_staff_id}</td>
                  <td>{new Date(row.effective_from).toLocaleString()}</td>
                  <td>{row.effective_to ? new Date(row.effective_to).toLocaleString() : 'Current'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <EmptyState title="No reporting lines">Set a supervisor above to establish field coverage.</EmptyState>}
        </section>
      </div>
    </>
  )
}