import { useCallback, useEffect, useState } from 'react'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'

const initialForm = () => ({ customerIdentifier: '', customerName: '', totalValue: '', downPayment: '0', installmentCount: '4', installmentFrequency: 'WEEKLY', firstDueDate: '', markupAmount: '0', lateFeeAmount: '0', lateFeeGraceDays: '0', missedInstallmentThreshold: '3' })
const money = (value) => `GHS ${Number(value || 0).toFixed(2)}`

export default function OperatorCreditPlans() {
  const { user } = useOperatorAuth()
  const [merchants, setMerchants] = useState([])
  const [merchantId, setMerchantId] = useState(user?.merchantId || '')
  const [plans, setPlans] = useState([])
  const [exposure, setExposure] = useState(null)
  const [plan, setPlan] = useState(null)
  const [form, setForm] = useState(initialForm)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhook, setWebhook] = useState(null)
  const [newWebhookSecret, setNewWebhookSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadMerchants = useCallback(async () => {
    if (!user?.tenantId) return
    const rows = await operatorApi.listMerchants(user.tenantId)
    const active = Array.isArray(rows) ? rows.filter((row) => row.isActive && row.accountSetupStatus === 'ACTIVE') : []
    setMerchants(active)
    if (!merchantId && active[0]) setMerchantId(active[0].id)
  }, [user?.tenantId, merchantId])

  const loadMerchantData = useCallback(async () => {
    if (!user?.tenantId || !merchantId) return
    const [planRows, exposureRow, webhookRow] = await Promise.all([
      operatorApi.listCreditPlans({ tenantId: user.tenantId, merchantId }),
      operatorApi.getCreditExposure({ tenantId: user.tenantId, merchantId }),
      operatorApi.getCreditWebhook(merchantId, user.tenantId).catch((requestError) => requestError.status === 404 ? null : Promise.reject(requestError))
    ])
    setPlans(Array.isArray(planRows) ? planRows : [])
    setExposure(exposureRow)
    setWebhook(webhookRow)
    if (plan) {
      const selected = await operatorApi.getCreditPlan(plan.id).catch(() => null)
      setPlan(selected)
    }
  }, [user?.tenantId, merchantId, plan?.id])

  useEffect(() => { loadMerchants().catch((requestError) => setError(requestError.message)).finally(() => setLoading(false)) }, [loadMerchants])
  useEffect(() => { loadMerchantData().catch((requestError) => setError(requestError.message)) }, [loadMerchantData])

  async function createPlan(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      const created = await operatorApi.createCreditPlan({
        tenantId: user.tenantId, merchantId, ...form,
        totalValue: Number(form.totalValue), downPayment: Number(form.downPayment || 0),
        installmentCount: Number(form.installmentCount), markupAmount: Number(form.markupAmount || 0),
        lateFeeAmount: Number(form.lateFeeAmount || 0), lateFeeGraceDays: Number(form.lateFeeGraceDays || 0),
        missedInstallmentThreshold: Number(form.missedInstallmentThreshold || 3)
      })
      setForm(initialForm())
      setNotice(`Credit plan created with ${created.installments} scheduled installments.`)
      await loadMerchantData()
      const detail = await operatorApi.getCreditPlan(created.id)
      setPlan(detail)
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  async function recordCash(installment) {
    if (!window.confirm(`Record installment ${installment.installment_number} as paid in cash (${money(installment.amount_due)})? This will not create an Eganow transaction.`)) return
    setError('')
    setNotice('')
    setBusy(true)
    try {
      await operatorApi.recordCreditCashPayment(plan.id, installment.id)
      setNotice('Cash payment recorded. No Eganow collection transaction was created.')
      const detail = await operatorApi.getCreditPlan(plan.id)
      setPlan(detail)
      await loadMerchantData()
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  async function copyPaymentLink(installment) {
    setError('')
    setNotice('')
    try {
      const result = await operatorApi.createCreditPaymentLink(plan.id, installment.id)
      await navigator.clipboard.writeText(result.url)
      setNotice(`Payment link copied. It expires ${new Date(result.expiresAt).toLocaleDateString()}.`)
    } catch (requestError) { setError(requestError.message) }
  }

  async function saveWebhook(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      const result = await operatorApi.saveCreditWebhook(merchantId, { tenantId: user.tenantId, url: webhookUrl })
      setWebhook(result)
      setWebhookUrl(result.url)
      setNewWebhookSecret(result.webhookSecret)
      setNotice('Webhook saved. Copy the signing secret now; it is shown only once.')
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  async function disableWebhook() {
    if (!window.confirm('Disable this credit webhook? Future payment status updates will no longer be delivered.')) return
    setError('')
    setBusy(true)
    try {
      await operatorApi.disableCreditWebhook(merchantId, user.tenantId)
      setWebhook((current) => current ? { ...current, active: false } : null)
      setNewWebhookSecret('')
      setNotice('Webhook disabled.')
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  return <div>
    <div className="portal-header"><div><h1>Hire-purchase & credit sales</h1><p>Create merchant-configured installment plans and track promised versus collected amounts.</p></div></div>
    {error && <div className="status-banner error" role="alert">{error}</div>}
    {notice && <div className="status-banner success" role="status">{notice}</div>}
    {loading ? <div className="empty-state">Loading credit sales…</div> : !merchants.length ? <div className="empty-state">Activate Eganow account setup for a merchant before creating credit plans.</div> : <>
      <section className="card">
        <div className="two-col"><div className="field"><label htmlFor="credit-merchant">Merchant</label>
          <select id="credit-merchant" value={merchantId} onChange={(event) => { setMerchantId(event.target.value); setPlan(null) }}>
            {merchants.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
          </select>
        </div></div>
        <div className="metrics-row">
          <div className="metric-card"><span>Outstanding promised</span><strong>{money(exposure?.total_outstanding_promised)}</strong></div>
          <div className="metric-card"><span>Actually collected</span><strong>{money(exposure?.total_actually_collected)}</strong></div>
          <div className="metric-card"><span>Overdue installments</span><strong>{exposure?.overdue_installment_count || 0}</strong></div>
        </div>
      </section>

      <form className="card" onSubmit={createPlan}>
        <h2>Create credit plan</h2>
        <div className="two-col">
          <div className="field"><label htmlFor="credit-customer">Customer mobile number</label><input id="credit-customer" required value={form.customerIdentifier} onChange={(event) => setForm({ ...form, customerIdentifier: event.target.value })} placeholder="0551234567" /></div>
          <div className="field"><label htmlFor="credit-name">Customer name</label><input id="credit-name" value={form.customerName} onChange={(event) => setForm({ ...form, customerName: event.target.value })} /></div>
          <div className="field"><label htmlFor="credit-value">Total sale value (GHS)</label><input id="credit-value" type="number" min="0.01" step="0.01" required value={form.totalValue} onChange={(event) => setForm({ ...form, totalValue: event.target.value })} /></div>
          <div className="field"><label htmlFor="credit-down">Down payment (GHS)</label><input id="credit-down" type="number" min="0" step="0.01" required value={form.downPayment} onChange={(event) => setForm({ ...form, downPayment: event.target.value })} /></div>
          <div className="field"><label htmlFor="credit-count">Installment count</label><input id="credit-count" type="number" min="1" max="120" step="1" required value={form.installmentCount} onChange={(event) => setForm({ ...form, installmentCount: event.target.value })} /></div>
          <div className="field"><label htmlFor="credit-frequency">Installment frequency</label><select id="credit-frequency" value={form.installmentFrequency} onChange={(event) => setForm({ ...form, installmentFrequency: event.target.value })}><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></select></div>
          <div className="field"><label htmlFor="credit-first-due">First due date</label><input id="credit-first-due" type="date" required value={form.firstDueDate} onChange={(event) => setForm({ ...form, firstDueDate: event.target.value })} /></div>
          <div className="field"><label htmlFor="credit-markup">Markup (GHS)</label><input id="credit-markup" type="number" min="0" step="0.01" required value={form.markupAmount} onChange={(event) => setForm({ ...form, markupAmount: event.target.value })} /></div>
          <div className="field"><label htmlFor="credit-late-fee">Late fee per overdue installment (GHS)</label><input id="credit-late-fee" type="number" min="0" step="0.01" required value={form.lateFeeAmount} onChange={(event) => setForm({ ...form, lateFeeAmount: event.target.value })} /></div>
          <div className="field"><label htmlFor="credit-grace">Late fee grace days</label><input id="credit-grace" type="number" min="0" max="365" step="1" required value={form.lateFeeGraceDays} onChange={(event) => setForm({ ...form, lateFeeGraceDays: event.target.value })} /></div>
          <div className="field"><label htmlFor="credit-default-threshold">Missed installment threshold</label><input id="credit-default-threshold" type="number" min="1" max="120" step="1" required value={form.missedInstallmentThreshold} onChange={(event) => setForm({ ...form, missedInstallmentThreshold: event.target.value })} /></div>
        </div>
        <p className="policy-hint">Installments are full payments. The financed balance plus markup is divided evenly, with any rounding remainder added to the final installment.</p>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create credit plan'}</button>
      </form>

      <section className="card"><h2>Credit plans</h2>
        {!plans.length ? <div className="empty-state">No credit plans for this merchant yet.</div> : plans.map((item) => <button type="button" className="credit-plan-row" key={item.id} onClick={() => operatorApi.getCreditPlan(item.id).then(setPlan).catch((requestError) => setError(requestError.message))}>
          <span><strong>{item.customer_name || item.customer_identifier}</strong><small>{item.customer_identifier} · {new Date(item.created_at).toLocaleDateString()}</small></span>
          <span>{money(item.total_value)} · {String(item.status).toLowerCase()}</span>
        </button>)}
      </section>

      {plan && <section className="card"><div className="portal-header"><div><h2>{plan.customer_name || plan.customer_identifier}</h2><p>{plan.customer_identifier} · {plan.status.toLowerCase()}</p></div><button className="btn btn-secondary" onClick={() => setPlan(null)}>Close</button></div>
        <div className="kv-row"><span>Outstanding promised</span><strong>{money(plan.outstanding_promised ?? plan.installments.filter((item) => item.status !== 'PAID').reduce((sum, item) => sum + Number(item.amount_due), 0))}</strong></div>
        <div className="kv-row"><span>Actually collected</span><strong>{money(plan.actually_collected ?? plan.installments.filter((item) => item.status === 'PAID').reduce((sum, item) => sum + Number(item.amount_due), 0))}</strong></div>
        {plan.installments.map((item) => <div className="credit-plan-row" key={item.id}>
          <span><strong>Installment {item.installment_number}</strong><small>{String(item.due_date).slice(0, 10)} · {money(item.amount_due)}{item.manually_recorded ? ' · cash recorded' : ''}</small></span>
          <span className="credit-plan-actions"><span className={`status-pill ${item.status.toLowerCase()}`}>{item.status.toLowerCase()}</span>
            {['PENDING', 'OVERDUE'].includes(item.status) && <>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => copyPaymentLink(item)}>Copy payment link</button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => recordCash(item)}>Record cash</button>
            </>}
          </span>
        </div>)}
      </section>}

      <section className="card"><h2>Merchant status webhooks</h2><p className="subtle">Webhook-only status integration. Deliveries use the signed <code>x-xorganam-signature</code> header and retry with backoff.</p>
        <form onSubmit={saveWebhook}><div className="field"><label htmlFor="credit-webhook-url">HTTPS endpoint URL</label><input id="credit-webhook-url" type="url" required value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://merchant.example/hooks/xorganam" /></div>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : webhook?.active ? 'Rotate secret and update webhook' : 'Configure webhook'}</button>
          {webhook?.active && <button type="button" className="btn btn-secondary" disabled={busy} onClick={disableWebhook}>Disable webhook</button>}
        </form>
        {newWebhookSecret && <div className="status-banner success" style={{ marginTop: 12 }}><span>Signing secret (copy now): <code>{newWebhookSecret}</code></span><button className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(newWebhookSecret)}>Copy</button></div>}
      </section>
    </>}
  </div>
}
