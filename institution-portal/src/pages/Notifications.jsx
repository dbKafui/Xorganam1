import { useCallback, useEffect, useState } from 'react'
import PageHeader from '../components/PageHeader.jsx'
import { ErrorMessage, LoadingState, SuccessMessage } from '../components/Feedback.jsx'
import { institutionApi } from '../api/client.js'
import { useInstitutionAuth } from '../context/InstitutionAuthContext.jsx'

import { formatCurrencyMinorUnits } from '../../../shared/currency.js'
const events = [
  ['CONTRIBUTION_REMINDER', 'Savings contribution reminder'], ['REPAYMENT_DUE', 'Loan repayment due'],
  ['REPAYMENT_OVERDUE', 'Loan repayment overdue'], ['SAVINGS_MATURITY', 'Savings maturity'],
  ['VERIFICATION_APPROVED', 'Customer verification approved'], ['VERIFICATION_REJECTED', 'Customer verification rejected'],
  ['DISPUTE_UPDATE', 'Dispute update']
]
const defaultText = {
  CONTRIBUTION_REMINDER: 'Hello {customerName}, please remember your {productName} savings contribution. Minimum contribution: GHS {amount}.',
  REPAYMENT_DUE: 'Hello {customerName}, GHS {amount} for {productName} is due on {dueDate}.',
  REPAYMENT_OVERDUE: 'Hello {customerName}, GHS {amount} for {productName} was due on {dueDate}. Please contact your institution.',
  SAVINGS_MATURITY: 'Hello {customerName}, your {productName} savings matured on {dueDate}. Balance: GHS {amount}.',
  VERIFICATION_APPROVED: 'Hello {customerName}, your customer verification has been approved.',
  VERIFICATION_REJECTED: 'Hello {customerName}, your customer verification needs attention. Please contact your institution.',
  DISPUTE_UPDATE: 'Hello {customerName}, there is an update to your institution service request.'
}
const defaults = Object.fromEntries(events.map(([event]) => [event, { event, enabled: false, templateText: defaultText[event] }]))
const amount = (cents) => formatCurrencyMinorUnits(cents || 0, 'GHS')

export default function Notifications() {
  const { staff } = useInstitutionAuth()
  const isAdmin = staff?.role === 'INSTITUTION_ADMIN'
  const [settings, setSettings] = useState(defaults)
  const [customers, setCustomers] = useState([])
  const [logs, setLogs] = useState([])
  const [form, setForm] = useState({ customerId: '', event: 'CONTRIBUTION_REMINDER', amount: '', dueDate: '', productName: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const [templates, customerRows, logRows] = await Promise.all([
      institutionApi.listNotificationSettings(), institutionApi.listFinanceCustomers(), institutionApi.listNotificationLog()
    ])
    const next = { ...defaults }
    for (const setting of templates) next[setting.event] = { ...setting }
    setSettings(next); setCustomers(customerRows); setLogs(logRows)
  }, [])
  useEffect(() => { load().catch((e) => setError(e.message)).finally(() => setLoading(false)) }, [load])

  async function perform(action, success) {
    setSaving(true); setError(''); setNotice('')
    try { await action(); setNotice(success); await load() }
    catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  if (loading) return <><PageHeader eyebrow="INSTITUTION / CUSTOMER CARE" title="Notifications" description="Configure SMS templates, send member notices, and review delivery history." /><LoadingState /></>
  return <>
    <PageHeader eyebrow="INSTITUTION / CUSTOMER CARE" title="Notifications" description="Manage institution SMS templates and member delivery history." />
    <ErrorMessage>{error}</ErrorMessage><SuccessMessage>{notice}</SuccessMessage>

    {isAdmin && <section className="surface">
      <div className="section-head"><div><div className="eyebrow">SMS POLICY</div><h2>Templates and automated notices</h2></div></div>
      <p className="footnote">Supported placeholders: {'{customerName}'}, {'{amount}'}, {'{dueDate}'}, and {'{productName}'}. Automated repayment, contribution, maturity, and KYC notices run only when enabled and the customer has opted into notifications.</p>
      <form className="form-grid" onSubmit={(event) => { event.preventDefault(); perform(() => institutionApi.saveNotificationSettings(Object.values(settings).map(({ event: key, enabled, templateText }) => ({ event: key, enabled, templateText }))), 'Notification settings saved.') }}>
        {events.map(([key, label]) => <div className="form-field" key={key}>
          <span>{label}</span>
          <label className="checkbox-field"><input type="checkbox" checked={Boolean(settings[key].enabled)} onChange={(e) => setSettings({ ...settings, [key]: { ...settings[key], enabled: e.target.checked } })} /><span>Enabled</span></label>
          <textarea required maxLength="500" value={settings[key].templateText} onChange={(e) => setSettings({ ...settings, [key]: { ...settings[key], templateText: e.target.value } })} placeholder="SMS message template" />
        </div>)}
        <div className="form-span form-actions"><button className="button button-primary" disabled={saving}>Save notification settings</button></div>
      </form>
    </section>}

    <section className="surface">
      <div className="section-head"><div><div className="eyebrow">AD-HOC SMS</div><h2>Send a member notification</h2></div></div>
      <form className="form-grid" onSubmit={(event) => { event.preventDefault(); perform(() => institutionApi.sendInstitutionNotification({ ...form, amount: form.amount || undefined, dueDate: form.dueDate || undefined, productName: form.productName || undefined }), 'Notification delivery attempt recorded.') }}>
        <label className="form-field"><span>Customer</span><select required value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}><option value="">Select customer</option>{customers.filter((c) => c.is_active && c.kyc_status === 'VERIFIED').map((c) => <option key={c.id} value={c.id}>{c.first_name} {c.last_name} · {c.customer_number}{c.notification_consent ? '' : ' · no consent'}</option>)}</select></label>
        <label className="form-field"><span>Notification event</span><select value={form.event} onChange={(e) => setForm({ ...form, event: e.target.value })}>{events.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="form-field"><span>Amount (GHS, optional)</span><input type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label className="form-field"><span>Due date (optional)</span><input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></label>
        <label className="form-field"><span>Product name (optional)</span><input maxLength="100" value={form.productName} onChange={(e) => setForm({ ...form, productName: e.target.value })} /></label>
        <div className="form-span form-actions"><button className="button button-primary" disabled={saving}>Send using saved template</button></div>
      </form>
    </section>

    <section className="surface">
      <div className="section-head"><div><div className="eyebrow">DELIVERY LOG</div><h2>Recent SMS activity</h2></div><span className="count-pill">{logs.length}</span></div>
      <div className="table-wrap"><table><thead><tr><th>Customer</th><th>Event</th><th>Delivery</th><th>Attempted</th><th>Sent</th><th>Details</th></tr></thead><tbody>
        {logs.map((row) => <tr key={row.id}><td>{row.first_name} {row.last_name}<small>{row.customer_number}</small></td><td>{row.event.replaceAll('_', ' ')}</td><td>{row.delivery_status}</td><td>{new Date(row.attempted_at).toLocaleString()}</td><td>{row.sent_at ? new Date(row.sent_at).toLocaleString() : '—'}</td><td>{row.failure_reason || '—'}</td></tr>)}
        {!logs.length && <tr><td colSpan="6">No notification delivery attempts yet.</td></tr>}
      </tbody></table></div>
    </section>
  </>
}
