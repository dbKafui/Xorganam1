import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'

const STATUS_TABS = ['PENDING', 'APPROVED', 'REJECTED']

export default function InstitutionApplications() {
  const [status, setStatus] = useState('PENDING')
  const [applications, setApplications] = useState([])
  const [notes, setNotes] = useState({})
  const [verification, setVerification] = useState({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    const rows = await api.get('/institution-onboarding/applications', { status })
    setApplications(rows || [])
  }, [status])

  useEffect(() => { load().catch((requestError) => setError(requestError.message)) }, [load])

  async function review(application, decision) {
    const note = String(notes[application.id] || '').trim()
    const checks = verification[application.id] || {}
    if (decision === 'APPROVED' && (!checks.legalEntity || !checks.settlementAccount || !checks.applicantAuthority)) {
      setError('Complete all independent verification checks before approving.')
      return
    }
    if (decision === 'REJECTED' && note.length < 5) {
      setError('Enter a rejection reason of at least five characters.')
      return
    }
    const confirmed = window.confirm(
      decision === 'APPROVED'
        ? `Approve ${application.institution_name} and activate the applicant’s initial institution administrator? Verify the institution and representative through an independent channel first.`
        : `Reject ${application.institution_name}'s onboarding application?`
    )
    if (!confirmed) return
    setBusy(application.id); setError(''); setNotice('')
    try {
      if (decision === 'APPROVED') {
        await api.post(`/institution-onboarding/applications/${application.id}/approve`, { reviewerNote: note, verification: checks })
        setNotice(`${application.institution_name} approved. The applicant can now sign in to the Institution Portal.`)
      } else {
        await api.post(`/institution-onboarding/applications/${application.id}/reject`, { reason: note })
        setNotice(`${application.institution_name} application rejected.`)
      }
      setNotes((current) => { const next = { ...current }; delete next[application.id]; return next })
      setVerification((current) => { const next = { ...current }; delete next[application.id]; return next })
      await load()
    } catch (requestError) { setError(requestError.message) }
    finally { setBusy('') }
  }

  return <div>
    <header className="page-header"><div><h1>Institution applications</h1><p>Review applications before creating institution workspaces and their first administrator account.</p></div></header>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {notice && <div className="alert alert-success" role="status">{notice}</div>}
    <section className="panel">
      <div className="filter-tabs">{STATUS_TABS.map((item) => <button key={item} className={`filter-tab${status === item ? ' selected' : ''}`} onClick={() => { setStatus(item); setError('') }}>{item}</button>)}</div>
      <p className="subtle">For pending applications, verify the institution’s legal identity, settlement account, and applicant authority using a contact source independent of this application before approving.</p>
      {applications.length ? <div className="table-wrap"><table><thead><tr><th>Institution</th><th>Settlement details</th><th>Initial administrator</th><th>Submitted / decision</th><th>Review note</th><th>Actions</th></tr></thead><tbody>
        {applications.map((application) => <tr key={application.id}>
          <td><strong>{application.institution_name}</strong><small>{application.institution_type.replaceAll('_', ' ')}</small><small className="mono">{application.id}</small></td>
          <td>{application.settlement_account_name}<small>{application.settlement_msisdn}</small></td>
          <td>{application.admin_first_name} {application.admin_last_name}<small>{application.admin_email}</small></td>
          <td>{new Date(application.created_at).toLocaleString()}<small>{application.reviewed_at ? `Reviewed ${new Date(application.reviewed_at).toLocaleString()}` : 'Awaiting review'}</small></td>
          <td>{application.status === 'PENDING' ? <>
            <textarea rows="2" maxLength="2000" value={notes[application.id] || ''} onChange={(event) => setNotes({ ...notes, [application.id]: event.target.value })} placeholder="Optional approval note; required rejection reason" />
            <div className="onboarding-verification-checks">
              <label><input type="checkbox" checked={!!verification[application.id]?.legalEntity} onChange={(event) => setVerification((current) => ({ ...current, [application.id]: { ...current[application.id], legalEntity: event.target.checked } }))} /> Legal entity independently checked</label>
              <label><input type="checkbox" checked={!!verification[application.id]?.settlementAccount} onChange={(event) => setVerification((current) => ({ ...current, [application.id]: { ...current[application.id], settlementAccount: event.target.checked } }))} /> Settlement account independently checked</label>
              <label><input type="checkbox" checked={!!verification[application.id]?.applicantAuthority} onChange={(event) => setVerification((current) => ({ ...current, [application.id]: { ...current[application.id], applicantAuthority: event.target.checked } }))} /> Applicant authority independently checked</label>
            </div>
          </> : application.reviewer_note || '—'}</td>
          <td>{application.status === 'PENDING' && <><button className="btn btn-primary" disabled={!!busy} onClick={() => review(application, 'APPROVED')}>Approve</button> <button className="btn btn-secondary" disabled={!!busy} onClick={() => review(application, 'REJECTED')}>Reject</button></>}</td>
        </tr>)}
      </tbody></table></div> : <p className="empty-state">No {status.toLowerCase()} institution applications.</p>}
    </section>
  </div>
}
