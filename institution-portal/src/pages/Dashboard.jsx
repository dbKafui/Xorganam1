import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { institutionApi } from '../api/client.js'
import { useInstitutionAuth } from '../context/InstitutionAuthContext.jsx'
import PageHeader from '../components/PageHeader.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import { EmptyState, ErrorMessage, LoadingState } from '../components/Feedback.jsx'

function StatCard({ label, value, number, to }) {
  const content = (
    <>
      <div className="stat-top"><span>{label}</span><span className="stat-arrow">↗</span></div>
      <div className="stat-value">{value ?? '—'}</div>
      <div className="stat-number">{number}</div>
    </>
  )
  return to ? <Link className="stat-card" to={to}>{content}</Link> : <div className="stat-card">{content}</div>
}

export default function Dashboard() {
  const { staff } = useInstitutionAuth()
  const [summary, setSummary] = useState(null)
  const [links, setLinks] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([institutionApi.dashboard(), institutionApi.listLinks()])
      .then(([dashboard, queue]) => {
        setSummary(dashboard)
        setLinks(Array.isArray(queue) ? queue : [])
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false))
  }, [])

  const visibleLinks = staff?.role === 'FIELD_OFFICER'
    ? links.filter((link) => link.assigned_field_officer_id === staff.id)
    : links
  const pending = visibleLinks.filter((link) => ['PENDING', 'UNDER_REVIEW'].includes(link.verification_status))
  const recent = visibleLinks.slice(0, 5)
  const canSeeStaff = ['SUPERVISOR', 'INSTITUTION_ADMIN'].includes(staff?.role)

  return (
    <>
      <PageHeader eyebrow="OPERATIONS / OVERVIEW" title="Institution overview" description="A live snapshot of membership verification and settlement operations." action={<span className="live-chip"><i /> Live workspace</span>} />
      <ErrorMessage>{error}</ErrorMessage>
      {loading ? <LoadingState /> : summary && (
        <>
          <section className="stat-grid">
            <StatCard label="Institution links" value={visibleLinks.length} number="MEMBERSHIP LINKS" to="/verification" />
            <StatCard label="Needs attention" value={pending.length} number="PENDING VERIFICATION" to="/verification" />
            <StatCard label="Open disputes" value={summary.openDisputes} number="AWAITING REVIEW" to="/disputes" />
            <StatCard label="Active staff" value={canSeeStaff ? summary.activeStaff : '—'} number="TEAM MEMBERS" to={canSeeStaff ? '/staff' : null} />
          </section>
          <div className="content-grid dashboard-grid">
            <section className="surface">
              <div className="section-head"><div><div className="eyebrow">MEMBERSHIP</div><h2>Recent institution links</h2></div><Link className="text-link" to="/verification">Open queue <span>→</span></Link></div>
              {recent.length ? (
                <div className="table-wrap"><table>
                  <thead><tr><th>Tenant</th><th>Member reference</th><th>Method</th><th>Status</th></tr></thead>
                  <tbody>{recent.map((link) => (
                    <tr key={link.id}><td><strong>{link.tenant_name || 'Tenant'}</strong><small>{link.tenant_email || link.tenant_id}</small></td><td className="mono">{link.member_id || '—'}</td><td>{link.verification_method || 'MANUAL'}</td><td><StatusBadge value={link.verification_status} /></td></tr>
                  ))}</tbody>
                </table></div>
              ) : <EmptyState title="No institution links">New membership claims will appear here.</EmptyState>}
            </section>
            <section className="surface status-surface">
              <div className="eyebrow">QUEUE PULSE</div><h2>Verification status</h2>
              <div className="queue-total"><strong>{pending.length}</strong><span>items need review</span></div>
              <div className="queue-row"><span><i className="dot dot-amber" /> Pending</span><strong>{visibleLinks.filter((link) => link.verification_status === 'PENDING').length}</strong></div>
              <div className="queue-row"><span><i className="dot dot-blue" /> Under review</span><strong>{visibleLinks.filter((link) => link.verification_status === 'UNDER_REVIEW').length}</strong></div>
              <Link to="/verification" className="button button-outline button-wide">Review queue <span>→</span></Link>
            </section>
          </div>
        </>
      )}
    </>
  )
}
