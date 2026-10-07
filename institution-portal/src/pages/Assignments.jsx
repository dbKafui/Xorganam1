import { useCallback, useEffect, useState } from 'react'
import { institutionApi } from '../api/client.js'
import PageHeader from '../components/PageHeader.jsx'
import { EmptyState, ErrorMessage, LoadingState, SuccessMessage } from '../components/Feedback.jsx'

export default function Assignments() {
  const [staff, setStaff] = useState([])
  const [links, setLinks] = useState([])
  const [assignments, setAssignments] = useState([])
  const [linkId, setLinkId] = useState('')
  const [officerId, setOfficerId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const [staffRows, linkRows, assignmentRows] = await Promise.all([
      institutionApi.listStaff(), institutionApi.listLinks(), institutionApi.listAssignments()
    ])
    setStaff(Array.isArray(staffRows) ? staffRows : [])
    setLinks(Array.isArray(linkRows) ? linkRows : [])
    setAssignments(Array.isArray(assignmentRows) ? assignmentRows : [])
  }, [])

  useEffect(() => {
    load().catch((requestError) => setError(requestError.message)).finally(() => setLoading(false))
  }, [load])

  const officers = staff.filter((person) => person.role === 'FIELD_OFFICER' && person.is_active)

  async function submit(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setSaving(true)
    try {
      await institutionApi.createAssignment({ tenantInstitutionLinkId: linkId, fieldOfficerStaffId: officerId })
      setNotice('Field officer assignment saved.')
      await load()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageHeader eyebrow="TEAM / COVERAGE" title="Field assignments" description="Assign institution links to field officers. Reassignment keeps the prior assignment history." />
      <ErrorMessage>{error}</ErrorMessage><SuccessMessage>{notice}</SuccessMessage>
      <div className="content-grid assignment-grid">
        <section className="surface">
          <div className="eyebrow">NEW ASSIGNMENT</div><h2>Assign a field officer</h2>
          <p className="subtle">The active assignment is replaced when a new officer is selected.</p>
          <form onSubmit={submit} className="form-stack">
            <label className="form-field"><span>Institution link</span><select required value={linkId} onChange={(event) => setLinkId(event.target.value)}><option value="">Select tenant link</option>{links.map((link) => <option key={link.id} value={link.id}>{link.tenant_name || link.tenant_id} · {link.member_id || 'No member ID'}</option>)}</select></label>
            <label className="form-field"><span>Field officer</span><select required value={officerId} onChange={(event) => setOfficerId(event.target.value)}><option value="">Select officer</option>{officers.map((person) => <option key={person.id} value={person.id}>{person.first_name} {person.last_name} · {person.email}</option>)}</select></label>
            {!officers.length && <div className="inline-hint">No active field officers found. An Institution Admin can add staff from the Staff page.</div>}
            <button className="button button-primary" disabled={saving || !officers.length}>{saving ? 'Saving...' : 'Save assignment'} <span>→</span></button>
          </form>
        </section>
        <section className="surface">
          <div className="section-head"><div><div className="eyebrow">ASSIGNMENT HISTORY</div><h2>Current and prior coverage</h2></div><span className="count-pill">{assignments.length}</span></div>
          {loading ? <LoadingState /> : assignments.length ? (
            <div className="table-wrap"><table><thead><tr><th>Tenant link</th><th>Officer</th><th>Effective</th><th>Record</th></tr></thead><tbody>
              {assignments.map((assignment) => <tr key={assignment.id}><td><strong>{assignment.tenant_id?.slice(0, 8)}</strong><small>{assignment.member_id || assignment.tenant_institution_link_id?.slice(0, 8)}</small></td><td>{assignment.officer_name || assignment.field_officer_staff_id?.slice(0, 8)}</td><td>{new Date(assignment.effective_from).toLocaleDateString()}</td><td>{assignment.effective_to ? 'Ended' : 'Active'}</td></tr>)}
            </tbody></table></div>
          ) : <EmptyState title="No assignments yet">Choose a tenant link and field officer to create the first assignment.</EmptyState>}
        </section>
      </div>
    </>
  )
}
