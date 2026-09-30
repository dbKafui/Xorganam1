import { useCallback, useEffect, useState } from 'react'
import { institutionApi } from '../api/client.js'
import { useInstitutionAuth } from '../context/InstitutionAuthContext.jsx'
import PageHeader from '../components/PageHeader.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import { EmptyState, ErrorMessage, LoadingState, SuccessMessage } from '../components/Feedback.jsx'

export default function Disputes() {
  const { staff } = useInstitutionAuth()
  const [rows, setRows] = useState([])
  const [form, setForm] = useState({ tenantId: '', merchantId: '', transactionId: '', reason: '', channel: 'EMAIL' })
  const [resolutionNotes, setResolutionNotes] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [workingId, setWorkingId] = useState('')
  const canResolve = ['SUPERVISOR', 'INSTITUTION_ADMIN'].includes(staff?.role)
  const load = useCallback(() => institutionApi.listDisputes().then((data) => setRows(Array.isArray(data) ? data : [])), [])

  useEffect(() => {
    load().catch((requestError) => setError(requestError.message)).finally(() => setLoading(false))
  }, [load])

  async function submit(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setSaving(true)
    try {
      await institutionApi.createDispute(form)
      setForm({ tenantId: '', merchantId: '', transactionId: '', reason: '', channel: 'EMAIL' })
      setNotice('Dispute recorded for review.')
      await load()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  async function transition(row, status) {
    setError('')
    setNotice('')
    setWorkingId(row.id)
    try {
      await institutionApi.updateDispute(row.id, {
        status,
        resolutionNote: resolutionNotes[row.id] || ''
      })
      setNotice(`Dispute moved to ${status.replaceAll('_', ' ').toLowerCase()}.`)
      await load()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setWorkingId('')
    }
  }

  return (
    <>
      <PageHeader eyebrow="CASE MANAGEMENT" title="Disputes & flags" description="Record a transaction dispute and track institution review status." />
      <ErrorMessage>{error}</ErrorMessage><SuccessMessage>{notice}</SuccessMessage>
      <div className="content-grid disputes-grid">
        <section className="surface">
          <div className="eyebrow">NEW CASE</div><h2>Raise a dispute</h2>
          <p className="subtle">Use transaction IDs from reconciliation or the transaction report. A dispute must reference a transaction associated with an approved institution link.</p>
          <form className="form-stack" onSubmit={submit}>
            <label className="form-field"><span>Tenant ID</span><input required value={form.tenantId} onChange={(event) => setForm({ ...form, tenantId: event.target.value })} placeholder="UUID" /></label>
            <label className="form-field"><span>Merchant ID</span><input required value={form.merchantId} onChange={(event) => setForm({ ...form, merchantId: event.target.value })} placeholder="UUID" /></label>
            <label className="form-field"><span>Transaction ID</span><input required value={form.transactionId} onChange={(event) => setForm({ ...form, transactionId: event.target.value })} placeholder="Collection or sweep transaction UUID" /></label>
            <label className="form-field"><span>Channel</span><select value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value })}><option value="EMAIL">Email</option><option value="APP">App</option></select></label>
            <label className="form-field"><span>Reason</span><textarea required rows="4" maxLength="2000" value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="Describe the discrepancy or concern..." /></label>
            <button className="button button-primary" disabled={saving}>{saving ? 'Recording...' : 'Record dispute'} <span>→</span></button>
          </form>
        </section>
        <section className="surface">
          <div className="section-head"><div><div className="eyebrow">INSTITUTION CASES</div><h2>Recent disputes</h2></div><span className="count-pill">{rows.length}</span></div>
          {loading ? <LoadingState /> : rows.length ? <div className="case-list">
            {rows.map((row) => <article className="case-card" key={row.id}>
              <div className="case-top"><StatusBadge value={row.status} /><span className="case-date">{new Date(row.created_at).toLocaleDateString()}</span></div>
              <p>{row.reason}</p>
              <div className="case-meta"><span>Tenant <code>{row.tenant_id?.slice(0, 8)}</code></span><span>Merchant <code>{row.merchant_id?.slice(0, 8)}</code></span></div>
              {row.transaction_id && <div className="case-ref">Transaction <code>{row.transaction_id}</code></div>}
              {row.resolution_note && <div className="case-ref">Resolution: {row.resolution_note}</div>}
              {canResolve && row.status !== 'RESOLVED' && <div className="review-actions">
                <input aria-label={`Resolution note for dispute ${row.id}`} placeholder="Optional resolution note" value={resolutionNotes[row.id] || ''} onChange={(event) => setResolutionNotes({ ...resolutionNotes, [row.id]: event.target.value })} />
                {row.status === 'OPEN' && <button className="button button-secondary button-small" disabled={workingId === row.id} onClick={() => transition(row, 'UNDER_REVIEW')}>Start review</button>}
                {row.status === 'UNDER_REVIEW' && <button className="button button-primary button-small" disabled={workingId === row.id} onClick={() => transition(row, 'RESOLVED')}>{workingId === row.id ? 'Saving...' : 'Resolve'}</button>}
              </div>}
            </article>)}
          </div> : <EmptyState title="No disputes recorded">New institution cases will appear here.</EmptyState>}
        </section>
      </div>
      <p className="footnote">Status transitions are enforced by the API: open cases can enter review, and unresolved cases can be resolved by supervisors or institution administrators.</p>
    </>
  )
}
