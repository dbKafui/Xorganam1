import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { institutionApi } from '../api/client.js'
import { useInstitutionAuth } from '../context/InstitutionAuthContext.jsx'
import PageHeader from '../components/PageHeader.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import { EmptyState, ErrorMessage, LoadingState, SuccessMessage } from '../components/Feedback.jsx'

export default function Verification() {
  const { staff } = useInstitutionAuth()
  const [links, setLinks] = useState([])
  const [filter, setFilter] = useState('OPEN')
  const [search, setSearch] = useState('')
  const [notes, setNotes] = useState({})
  const [evidenceByLink, setEvidenceByLink] = useState({})
  const [evidenceForms, setEvidenceForms] = useState({})
  const [expandedLinkId, setExpandedLinkId] = useState('')
  const [loading, setLoading] = useState(true)
  const [workingId, setWorkingId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(() => institutionApi.listLinks().then((data) => setLinks(Array.isArray(data) ? data : [])), [])
  useEffect(() => {
    load().catch((requestError) => setError(requestError.message)).finally(() => setLoading(false))
  }, [load])

  const visible = useMemo(() => links.filter((link) => {
    const status = link.verification_status
    if (filter === 'OPEN' && !['PENDING', 'UNDER_REVIEW'].includes(status)) return false
    if (filter !== 'OPEN' && filter !== 'ALL' && status !== filter) return false
    if (search && !`${link.tenant_name} ${link.tenant_email} ${link.member_id}`.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [filter, links, search])

  function mayReview(link) {
    if (!['PENDING', 'UNDER_REVIEW'].includes(link.verification_status)) return false
    if (staff.role === 'INSTITUTION_ADMIN') return true
    if (staff.role === 'SUPERVISOR') {
      return !link.assigned_field_officer_id ||
        link.escalated_to_supervisor_id === staff.id ||
        link.assigned_supervisor_staff_id === staff.id
    }
    return staff.role === 'FIELD_OFFICER' &&
      link.assigned_field_officer_id === staff.id &&
      !link.escalated_to_supervisor_id
  }

  async function decide(link, decision) {
    setError('')
    setNotice('')
    setWorkingId(link.id)
    try {
      await institutionApi.verifyLink(link.id, { decision, note: notes[link.id] || '' })
      setNotice(decision === 'UNDER_REVIEW'
        ? `Review started for ${link.tenant_name || 'tenant'}.`
        : `Membership ${decision.toLowerCase()} for ${link.tenant_name || 'tenant'}.`)
      await load()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setWorkingId('')
    }
  }

  async function toggleEvidence(linkId) {
    if (expandedLinkId === linkId) {
      setExpandedLinkId('')
      return
    }
    setError('')
    setExpandedLinkId(linkId)
    try {
      const evidence = await institutionApi.listLinkEvidence(linkId)
      setEvidenceByLink((previous) => ({ ...previous, [linkId]: evidence }))
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  async function addEvidence(link) {
    const form = evidenceForms[link.id] || {}
    setError('')
    setNotice('')
    setWorkingId(link.id)
    try {
      await institutionApi.addLinkEvidence(link.id, {
        merchantId: form.merchantId,
        note: form.note || ''
      })
      const evidence = await institutionApi.listLinkEvidence(link.id)
      setEvidenceByLink((previous) => ({ ...previous, [link.id]: evidence }))
      setEvidenceForms((previous) => ({ ...previous, [link.id]: { ...previous[link.id], note: '' } }))
      setNotice('Verification evidence recorded.')
      await load()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setWorkingId('')
    }
  }

  return (
    <>
      <PageHeader eyebrow="MEMBERSHIP / REVIEW" title="Verification queue" description="Review tenant membership claims linked to your institution." />
      <ErrorMessage>{error}</ErrorMessage><SuccessMessage>{notice}</SuccessMessage>
      <section className="surface">
        <div className="toolbar">
          <div className="filter-tabs" role="tablist" aria-label="Verification status">
            {[['OPEN', 'Needs review'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected'], ['ALL', 'All links']].map(([value, label]) => (
              <button key={value} className={filter === value ? 'filter-tab selected' : 'filter-tab'} onClick={() => setFilter(value)}>{label}</button>
            ))}
          </div>
          <label className="search-field"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tenants or member ID" /></label>
        </div>
        {loading ? <LoadingState /> : visible.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Tenant / contact</th><th>Member ID</th><th>Source</th><th>Assigned officer</th><th>Submitted</th><th>Status</th><th>Review action</th></tr></thead>
            <tbody>{visible.map((link) => (
              <Fragment key={link.id}>
              <tr>
                <td><strong>{link.tenant_name || 'Tenant'}</strong><small>{link.tenant_email || link.tenant_id}</small></td>
                <td className="mono">{link.member_id || 'Not provided'}</td>
                <td>{link.sourced_by_staff_name ? `${link.sourced_by_staff_name} (${String(link.source_channel || '').replaceAll('_', ' ').toLowerCase()})` : 'Tenant initiated'}</td>
                <td>{link.assigned_field_officer_id ? <span className="mono">{link.assigned_field_officer_id.slice(0, 8)}</span> : <span className="subtle">Unassigned</span>}</td>
                <td>{new Date(link.linked_at || link.created_at).toLocaleDateString()}</td>
                <td><StatusBadge value={link.verification_status} /></td>
                <td className="action-cell">
                  {mayReview(link) ? (
                    <div className="review-actions">
                      <input aria-label={`Review note for ${link.tenant_name || 'tenant'}`} placeholder="Optional note" value={notes[link.id] || ''} onChange={(event) => setNotes((previous) => ({ ...previous, [link.id]: event.target.value }))} />
                      {link.verification_status === 'PENDING' && <button className="button button-secondary button-small" disabled={workingId === link.id} onClick={() => decide(link, 'UNDER_REVIEW')}>Start review</button>}
                      <button className="button button-primary button-small" disabled={workingId === link.id} onClick={() => decide(link, 'APPROVED')}>{workingId === link.id ? 'Saving...' : 'Approve'}</button>
                      <button className="button button-danger button-small" disabled={workingId === link.id} onClick={() => decide(link, 'REJECTED')}>Reject</button>
                    </div>
                  ) : <span className="subtle">{link.escalated_to_supervisor_id && staff.role === 'FIELD_OFFICER' ? 'Escalated to supervisor' : 'No action available for your assignment'}</span>}
                  <button className="button button-secondary button-small" onClick={() => toggleEvidence(link.id)}>
                    {expandedLinkId === link.id ? 'Hide evidence' : `Evidence (${link.evidence_count || 0})`}
                  </button>
                </td>
              </tr>
              {expandedLinkId === link.id && <tr><td colSpan="7">
                <div className="surface evidence-panel">
                  <strong>Verification evidence</strong>
                  {evidenceByLink[link.id]?.length ? <ul className="evidence-list">{evidenceByLink[link.id].map((item) => (
                    <li key={item.id}><span>{item.merchant_name || item.merchant_id} · {new Date(item.recorded_at).toLocaleString()}</span>{item.note && <small>{item.note}</small>}</li>
                  ))}</ul> : <p className="subtle">No evidence has been recorded for this claim.</p>}
                  {mayReview(link) && <form className="review-actions" onSubmit={(event) => { event.preventDefault(); addEvidence(link) }}>
                    <input required aria-label="Evidence merchant ID" placeholder="Tenant merchant UUID" value={evidenceForms[link.id]?.merchantId || ''} onChange={(event) => setEvidenceForms((previous) => ({ ...previous, [link.id]: { ...previous[link.id], merchantId: event.target.value } }))} />
                    <input aria-label="Evidence note" placeholder="Optional evidence note" value={evidenceForms[link.id]?.note || ''} onChange={(event) => setEvidenceForms((previous) => ({ ...previous, [link.id]: { ...previous[link.id], note: event.target.value } }))} />
                    <button className="button button-primary button-small" disabled={workingId === link.id}>{workingId === link.id ? 'Saving...' : 'Record evidence'}</button>
                  </form>}
                </div>
              </td></tr>}
              </Fragment>
            ))}</tbody>
          </table></div>
        ) : <EmptyState title="No matching verification claims">Adjust the filter or search term to see other links.</EmptyState>}
      </section>
      <p className="footnote">Review access, escalation, and evidence recording are checked against the current institution assignment on every API request.</p>
    </>
  )
}
