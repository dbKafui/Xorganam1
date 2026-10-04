import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'

function optionFrequencyModes(option) {
  if (option.frequencyMode?.minimum === 'PERIODIC') return ['PERIODIC']
  if (option.frequencyMode?.maximum === 'PER_TRANSACTION') return ['PER_TRANSACTION']
  return ['PER_TRANSACTION', 'PERIODIC']
}

function scheduleText(schedule) {
  return schedule ? `Every ${schedule.interval} ${schedule.unit.toLowerCase()}` : 'Not applicable'
}

export default function OperatorInstitutions() {
  const { user } = useOperatorAuth()
  const [merchants, setMerchants] = useState([])
  const [options, setOptions] = useState([])
  const [institutions, setInstitutions] = useState([])
  const [links, setLinks] = useState([])
  const [financeProducts, setFinanceProducts] = useState([])
  const [financeCustomers, setFinanceCustomers] = useState([])
  const [financeAccounts, setFinanceAccounts] = useState([])
  const [financeFees, setFinanceFees] = useState([])
  const [financeTransactions, setFinanceTransactions] = useState([])
  const [financeRequest, setFinanceRequest] = useState({ customerId: '', productId: '', amount: '', termMonths: '', termDays: '' })
  const [financePayment, setFinancePayment] = useState({ accountId: '', transactionType: 'LOAN_REPAYMENT', amount: '', externalReference: '', phoneNumber: '' })
  const [linkInstitutionId, setLinkInstitutionId] = useState('')
  const [memberId, setMemberId] = useState('')
  const [scopeAcknowledged, setScopeAcknowledged] = useState(false)
  const [splitRules, setSplitRules] = useState([])
  const [splitRulesError, setSplitRulesError] = useState('')
  const [defaultSplitType, setDefaultSplitType] = useState('PERCENTAGE')
  const [defaultSplitAmount, setDefaultSplitAmount] = useState('')
  const [defaultSplitMode, setDefaultSplitMode] = useState('PER_TRANSACTION')
  const [defaultScheduleUnit, setDefaultScheduleUnit] = useState('MONTHS')
  const [defaultScheduleInterval, setDefaultScheduleInterval] = useState('1')
  const [defaultPriorityFirst, setDefaultPriorityFirst] = useState(false)
  const [splitType, setSplitType] = useState('PERCENTAGE')
  const [splitAmount, setSplitAmount] = useState('')
  const [merchantId, setMerchantId] = useState('')
  const [institutionId, setInstitutionId] = useState('')
  const [frequencyMode, setFrequencyMode] = useState('PER_TRANSACTION')
  const [scheduleUnit, setScheduleUnit] = useState('MONTHS')
  const [scheduleInterval, setScheduleInterval] = useState('1')
  const [vendorPayoutMode, setVendorPayoutMode] = useState('PER_TRANSACTION')
  const [priorityDeductionSelected, setPriorityDeductionSelected] = useState(false)
  const [scheduleAnchorDate, setScheduleAnchorDate] = useState(new Date().toISOString().slice(0, 10))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    if (!user?.tenantId) return
    const [merchantRows, institutionRows, partneredInstitutions, tenantLinks] = await Promise.all([
      operatorApi.listMerchants(user.tenantId),
      operatorApi.getInstitutionSettlementOptions(user.tenantId),
      operatorApi.listInstitutions(),
      operatorApi.listTenantInstitutionLinks(user.tenantId)
    ])
    setMerchants(Array.isArray(merchantRows) ? merchantRows.filter((merchant) => merchant.isActive) : [])
    setOptions(Array.isArray(institutionRows) ? institutionRows : [])
    setInstitutions(Array.isArray(partneredInstitutions) ? partneredInstitutions : [])
    setLinks(Array.isArray(tenantLinks) ? tenantLinks : [])
    const financeRows = await Promise.all([
      operatorApi.listInstitutionFinanceProducts(user.tenantId), operatorApi.listInstitutionFinanceCustomers(user.tenantId),
      operatorApi.listInstitutionFinanceAccounts(user.tenantId), operatorApi.listInstitutionFinanceFees(user.tenantId),
      operatorApi.listInstitutionFinanceTransactions(user.tenantId)
    ].map((request) => request.catch(() => [])))
    setFinanceProducts(financeRows[0]); setFinanceCustomers(financeRows[1]); setFinanceAccounts(financeRows[2]);
    setFinanceFees(financeRows[3]); setFinanceTransactions(financeRows[4])
    if (user.role === 'TENANT_BRANCH_MANAGER' && merchantRows?.[0]?.id) setMerchantId(merchantRows[0].id)
    if (tenantLinks?.[0]?.institution_id) setInstitutionId((current) => current || tenantLinks[0].institution_id)
    const referralInstitution = sessionStorage.getItem('xorganam_referral_institution')
    if (referralInstitution) setLinkInstitutionId(referralInstitution)
  }, [user?.tenantId])

  useEffect(() => {
    load().catch((requestError) => setError(requestError.message)).finally(() => setLoading(false))
  }, [load])

  const selectedOption = useMemo(
    () => options.find((option) => option.institutionId === institutionId) || null,
    [institutionId, options]
  )
  const allowedModes = selectedOption ? optionFrequencyModes(selectedOption) : []
  const allowedVendorModes = Array.isArray(selectedOption?.vendorPayoutModes) && selectedOption.vendorPayoutModes.length
    ? selectedOption.vendorPayoutModes
    : ['PER_TRANSACTION']
  const selectedMerchant = merchants.find((merchant) => merchant.id === merchantId)
  const selectedLink = links.find((link) => link.institution_id === institutionId)
  const availableLinkInstitutions = institutions.filter((institution) =>
    !links.some((link) => link.institution_id === institution.id && link.status !== 'INACTIVE' && link.verification_status !== 'REJECTED')
  )

  useEffect(() => {
    if (selectedOption) {
      if (!allowedModes.includes(frequencyMode)) setFrequencyMode(allowedModes[0])
      if (!allowedModes.includes(defaultSplitMode)) setDefaultSplitMode(allowedModes[0])
      if (!allowedVendorModes.includes(vendorPayoutMode)) setVendorPayoutMode(allowedVendorModes[0])
      if (!selectedOption.priorityDeductionAllowed) setPriorityDeductionSelected(false)
      if (!selectedOption.priorityDeductionAllowed) setDefaultPriorityFirst(false)
      const minimum = selectedOption.periodicSchedule?.minimum
      const maximum = selectedOption.periodicSchedule?.maximum
      if (minimum) {
        setScheduleUnit(minimum.unit)
        setScheduleInterval(String(minimum.interval))
      } else if (maximum) {
        setScheduleUnit(maximum.unit)
        setScheduleInterval(String(maximum.interval))
      }
    }
  }, [selectedOption, allowedModes, allowedVendorModes, frequencyMode, defaultSplitMode, vendorPayoutMode])

  useEffect(() => {
    if (!user?.tenantId || !merchantId) return
    setSplitRulesError('')
    operatorApi.getSplitRules({ tenantId: user.tenantId, merchantId })
      .then((rows) => setSplitRules(Array.isArray(rows) ? rows : []))
      .catch((requestError) => {
        setSplitRules([])
        setSplitRulesError(requestError.message)
      })
  }, [user?.tenantId, merchantId])

  async function submit(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    if (!merchantId || !institutionId) {
      setError('Choose both a merchant and institution.')
      return
    }
    setSaving(true)
    try {
      await operatorApi.saveInstitutionSettlementConfig(merchantId, institutionId, {
        tenantId: user.tenantId,
        frequencyMode,
        periodicSchedule: frequencyMode === 'PERIODIC'
          ? { unit: scheduleUnit, interval: Number(scheduleInterval) }
          : null,
        priorityDeductionSelected,
        vendorPayoutMode,
        scheduleAnchorDate
      })
      setNotice('Institution settlement settings saved. The institution policy is also validated by the server.')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  async function submitLink(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setSaving(true)
    try {
      const params = new URLSearchParams(window.location.search)
      const ref = params.get('ref') || sessionStorage.getItem('xorganam_referral_code') || ''
      await operatorApi.createTenantInstitutionLink({
        tenantId: user.tenantId,
        institutionId: linkInstitutionId,
        memberId: memberId.trim(),
        ref: ref || undefined,
        acknowledgeTenantWideScope: user.role === 'TENANT_BRANCH_MANAGER' ? scopeAcknowledged : undefined
      })
      setNotice('Institution link submitted. Verification is pending; existing payment operations continue as usual.')
      setMemberId('')
      setScopeAcknowledged(false)
      await load()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  async function submitSplitRule(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setSaving(true)
    try {
      await operatorApi.saveSplitRule(merchantId, { tenantId: user.tenantId, institutionId, type: splitType, amount: Number(splitAmount) })
      setNotice('Split rule saved within the institution limits.')
      const rows = await operatorApi.getSplitRules({ tenantId: user.tenantId, merchantId })
      setSplitRules(Array.isArray(rows) ? rows : [])
    } catch (requestError) { setError(requestError.message) } finally { setSaving(false) }
  }

  async function submitDefaultSplitRule(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setSaving(true)
    try {
      await operatorApi.saveDefaultSplitRule({
        tenantId: user.tenantId,
        institutionId,
        type: defaultSplitType,
        amount: Number(defaultSplitAmount),
        mode: defaultSplitMode,
        periodicSchedule: defaultSplitMode === 'PERIODIC'
          ? { unit: defaultScheduleUnit, interval: Number(defaultScheduleInterval) }
          : null,
        legExecutionOrder: defaultPriorityFirst ? 'INSTITUTION_FIRST' : 'VENDOR_FIRST'
      })
      setNotice('Tenant default split rule saved. Merchant-specific overrides take precedence.')
      if (merchantId) {
        const rows = await operatorApi.getSplitRules({ tenantId: user.tenantId, merchantId })
        setSplitRules(Array.isArray(rows) ? rows : [])
      }
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  async function deactivateLink(link) {
    if (!window.confirm(`Deactivate the tenant-wide link to ${link.institution_name}? New split settlement will stop; outstanding payouts must be resolved first.`)) return
    setError('')
    setNotice('')
    setSaving(true)
    try {
      await operatorApi.deactivateTenantInstitutionLink(link.id, user.tenantId)
      setNotice('Institution link deactivated. Existing transaction history is retained.')
      await load()
    } catch (requestError) { setError(requestError.message) } finally { setSaving(false) }
  }

  async function requestFinancialAccount(event) {
    event.preventDefault(); setError(''); setNotice(''); setSaving(true)
    try {
      await operatorApi.requestInstitutionFinanceAccount({ tenantId: user.tenantId, customerId: financeRequest.customerId,
        productId: financeRequest.productId, requestedAmountCents: Math.round(Number(financeRequest.amount) * 100),
        termMonths: financeRequest.termMonths ? Number(financeRequest.termMonths) : undefined,
        termDays: financeRequest.termDays ? Number(financeRequest.termDays) : undefined })
      setFinanceRequest({ customerId: '', productId: '', amount: '', termMonths: '', termDays: '' })
      setNotice('Institution account application submitted for review.')
      await load()
    } catch (requestError) { setError(requestError.message) } finally { setSaving(false) }
  }

  async function recordFinancialPayment(event) {
    event.preventDefault(); setError(''); setNotice(''); setSaving(true)
    try {
      await operatorApi.createInstitutionFinanceTransaction({ tenantId: user.tenantId, accountId: financePayment.accountId,
        transactionType: financePayment.transactionType, amountCents: Math.round(Number(financePayment.amount) * 100), externalReference: financePayment.externalReference,
        phoneNumber: financePayment.phoneNumber, note: 'Started by tenant operator through the institution Eganow account.' })
      setFinancePayment({ accountId: '', transactionType: 'LOAN_REPAYMENT', amount: '', externalReference: '', phoneNumber: '' })
      setNotice(financePayment.transactionType === 'WITHDRAWAL' ? 'Savings withdrawal request sent to the institution for approval.' : 'Eganow collection started. Approve the prompt on the customer mobile.')
      await load()
    } catch (requestError) { setError(requestError.message) } finally { setSaving(false) }
  }

  return (
    <div>
      <div className="portal-header">
        <div>
          <h1>Institution links & settlement</h1>
          <p>Review institution policies and choose a settlement schedule for each merchant.</p>
        </div>
      </div>

      {error && <div className="status-banner error" role="alert"><span className="status-icon">!</span><span>{error}</span></div>}
      {notice && <div className="status-banner success" role="status"><span className="status-icon">✓</span><span>{notice}</span></div>}
      {loading ? <div className="empty-state">Loading institution policies…</div> : (
        <>
          <section className="card">
            <h2>Link a savings or loan institution</h2>
            <p className="subtle">Choose an institution and enter the membership ID to request verification.</p>
            {links.map((link) => <div className="kv-row" key={link.id}>
              <span>{link.institution_name} · {link.member_id}</span>
              <span><span className={`status-pill ${String(link.verification_status).toLowerCase()}`}>{link.status === 'INACTIVE' ? 'inactive' : String(link.verification_status).replaceAll('_', ' ')}</span>
                {['TENANT_ADMIN', 'TENANT_MANAGER'].includes(user.role) && link.status !== 'INACTIVE' && <button type="button" className="btn btn-secondary" disabled={saving} style={{ marginLeft: 8 }} onClick={() => deactivateLink(link)}>Deactivate</button>}
              </span>
            </div>)}
            <form onSubmit={submitLink}>
              <div className="two-col">
                <div className="field"><label htmlFor="link-institution">Institution</label>
                  <select id="link-institution" required value={linkInstitutionId} onChange={(event) => setLinkInstitutionId(event.target.value)}>
                    <option value="">Select institution</option>{availableLinkInstitutions.map((institution) => <option key={institution.id} value={institution.id}>{institution.name}</option>)}
                  </select>
                </div>
                <div className="field"><label htmlFor="member-id">Membership ID</label>
                  <input id="member-id" required value={memberId} onChange={(event) => setMemberId(event.target.value)} />
                </div>
              </div>
              {user.role === 'TENANT_BRANCH_MANAGER' && <label className="checkbox-field">
                <input type="checkbox" required checked={scopeAcknowledged} onChange={(event) => setScopeAcknowledged(event.target.checked)} />
                <span>I understand this institution link applies to every branch in this business.</span>
              </label>}
              {availableLinkInstitutions.length === 0 && <p className="policy-hint">A link to every available institution already exists. Rejected claims can be submitted again from the same institution.</p>}
              <button className="btn btn-primary" disabled={saving || availableLinkInstitutions.length === 0}>{saving ? 'Submitting…' : 'Request verification'}</button>
            </form>
          </section>
          <div className="card">
            <h2>Institution policies</h2>
            {!options.length ? <div className="empty-state">No active institution links are available for this tenant.</div> : (
              <div className="institution-policy-list">
                {options.map((option) => (
                  <article className="institution-policy" key={option.institutionId}>
                    <div className="institution-policy-title"><strong>{option.institutionName}</strong><span className="status-pill approved">Active link</span></div>
                    <div className="policy-details">
                      <span><small>Settlement mode</small><strong>{option.frequencyMode?.minimum || 'Flexible'}{option.frequencyMode?.maximum && option.frequencyMode.maximum !== option.frequencyMode.minimum ? ` to ${option.frequencyMode.maximum}` : ''}</strong></span>
                      <span><small>Periodic boundary</small><strong>{scheduleText(option.periodicSchedule?.minimum)}{option.periodicSchedule?.maximum ? ` - ${scheduleText(option.periodicSchedule.maximum)}` : ''}</strong></span>
                      <span><small>Vendor payout</small><strong>{(option.vendorPayoutModes || []).map((mode) => mode.replaceAll('_', ' ').toLowerCase()).join(', ') || 'Per transaction'}</strong></span>
                      <span><small>Priority deduction</small><strong>{option.priorityDeductionAllowed ? 'Allowed' : 'Not allowed'}</strong></span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>

          <section className="card">
            <h2>Institution loan and savings packages</h2>
            <p className="subtle">Active packages are available after the institution approves your link and associates a verified member customer with this tenant.</p>
            {!financeProducts.length ? <div className="empty-state">No active financial packages are available on your approved institution links.</div> : financeProducts.map((product) => <div className="kv-row" key={product.id}>
              <span><strong>{product.institution_name} · {product.name}</strong><small>{product.product_type} · GHS {(Number(product.min_amount_cents) / 100).toFixed(2)}–{(Number(product.max_amount_cents) / 100).toFixed(2)} · {(Number(product.annual_rate_basis_points) / 100).toFixed(2)}% annual</small></span>
              <span>{product.product_type === 'LOAN' ? `${product.tenor_options_months?.length ? `${product.tenor_options_months.join(', ')} months` : `${product.min_term_days}–${product.max_term_days} days`} · ${product.loan_interest_model || ''} · late fee ${(Number(product.late_fee_basis_points || 0) / 100).toFixed(2)}%` : `Min balance GHS ${(Number(product.min_balance_cents) / 100).toFixed(2)} · ${product.contribution_frequency || 'PER_TRANSACTION'}`}</span>
            </div>)}
            {financeProducts.length > 0 && ['TENANT_ADMIN', 'TENANT_MANAGER'].includes(user.role) && <form onSubmit={requestFinancialAccount}>
              <h3>Apply for a member account</h3>
              <div className="two-col">
                <div className="field"><label>Verified member</label><select required value={financeRequest.customerId} onChange={(e) => setFinanceRequest({ ...financeRequest, customerId: e.target.value })}><option value="">Select member</option>{financeCustomers.map((customer) => <option key={customer.id} value={customer.id}>{customer.institution_name} · {customer.first_name} {customer.last_name} · {customer.customer_number}</option>)}</select></div>
                <div className="field"><label>Package</label><select required value={financeRequest.productId} onChange={(e) => setFinanceRequest({ ...financeRequest, productId: e.target.value, termMonths: '', termDays: '' })}><option value="">Select package</option>{financeProducts.map((product) => <option key={product.id} value={product.id}>{product.institution_name} · {product.name} ({product.product_type})</option>)}</select></div>
                <div className="field"><label>Amount (GHS)</label><input required type="number" min="0.01" step="0.01" value={financeRequest.amount} onChange={(e) => setFinanceRequest({ ...financeRequest, amount: e.target.value })} /></div>
                {financeProducts.find((item) => item.id === financeRequest.productId)?.product_type === 'LOAN' && (financeProducts.find((item) => item.id === financeRequest.productId)?.tenor_options_months?.length ? <div className="field"><label>Loan tenor (months)</label><select required value={financeRequest.termMonths} onChange={(e) => setFinanceRequest({ ...financeRequest, termMonths: e.target.value })}><option value="">Select tenor</option>{financeProducts.find((item) => item.id === financeRequest.productId).tenor_options_months.map((months) => <option key={months} value={months}>{months} months</option>)}</select></div> : <div className="field"><label>Term (days)</label><input required type="number" min="1" value={financeRequest.termDays} onChange={(e) => setFinanceRequest({ ...financeRequest, termDays: e.target.value })} /></div>)}
              </div><button className="btn btn-primary" disabled={saving}>{saving ? 'Submitting…' : 'Submit application'}</button>
            </form>}
            <h3>Member accounts</h3>
            {!financeAccounts.length ? <p className="subtle">No linked member accounts yet.</p> : financeAccounts.map((account) => { const next = account.installments?.find((item) => item.status !== 'PAID'); const split = account.split_allocations?.[0]; return <div className="kv-row" key={account.id}><span><strong>{account.account_number} · {account.product_name}</strong><small>{account.institution_name} · {account.product_type} · GHS {(Number(account.product_type === 'LOAN' ? account.outstanding_cents : account.balance_cents) / 100).toFixed(2)} balance</small>{next && <small>Next payment {next.dueDate} · GHS {((Number(next.amountDueCents) - Number(next.amountPaidCents)) / 100).toFixed(2)}</small>}{split && <small>Latest split {split.type.replaceAll('_', ' ').toLowerCase()} · GHS {(Number(split.amountCents) / 100).toFixed(2)}</small>}</span><span className={`status-pill ${String(account.status).toLowerCase()}`}>{account.status.replaceAll('_', ' ').toLowerCase()}</span></div>})}
            {financeAccounts.some((item) => ['APPROVED', 'ACTIVE'].includes(item.status)) && ['TENANT_ADMIN', 'TENANT_MANAGER'].includes(user.role) && <form onSubmit={recordFinancialPayment}>
              <h3>Collect a contribution or repay a loan</h3><p className="subtle">Collections run through the linked institution’s own Eganow credentials. Savings withdrawals require institution approval before payout.</p>
              <div className="two-col">
              <div className="field"><label>Account</label><select required value={financePayment.accountId} onChange={(e) => setFinancePayment({ ...financePayment, accountId: e.target.value })}><option value="">Select account</option>{financeAccounts.filter((item) => ['APPROVED', 'ACTIVE'].includes(item.status) || (item.status === 'OVERDUE' && item.product_type === 'LOAN')).map((item) => <option key={item.id} value={item.id}>{item.institution_name} · {item.account_number} · {item.product_type}{item.status === 'OVERDUE' ? ' · overdue' : ''}</option>)}</select></div>
                <div className="field"><label>Operation</label><select value={financePayment.transactionType} onChange={(e) => setFinancePayment({ ...financePayment, transactionType: e.target.value })}><option value="LOAN_REPAYMENT">Loan repayment</option><option value="DEPOSIT">Savings contribution</option><option value="WITHDRAWAL">Savings withdrawal</option></select></div>
                <div className="field"><label>Amount (GHS)</label><input required type="number" min="0.01" step="0.01" value={financePayment.amount} onChange={(e) => setFinancePayment({ ...financePayment, amount: e.target.value })} /></div>
                <div className="field"><label>Customer mobile (233XXXXXXXXX)</label><input required pattern="233[0-9]{9}" value={financePayment.phoneNumber} onChange={(e) => setFinancePayment({ ...financePayment, phoneNumber: e.target.value })} /></div>
                <div className="field"><label>Transaction reference (optional)</label><input minLength="3" maxLength="160" value={financePayment.externalReference} onChange={(e) => setFinancePayment({ ...financePayment, externalReference: e.target.value })} placeholder="Generated if left blank" /></div>
              </div><button className="btn btn-primary" disabled={saving}>{saving ? 'Submitting…' : financePayment.transactionType === 'WITHDRAWAL' ? 'Request savings withdrawal' : 'Start Eganow collection'}</button>
            </form>}
            {financeFees.length > 0 && <><h3>Institution fees</h3>{financeFees.map((fee) => <div className="kv-row" key={`${fee.institution_id}-${fee.operation}`}><span>{fee.institution_name} · {fee.operation.replaceAll('_', ' ').toLowerCase()}</span><strong>{fee.fee_type === 'NONE' ? 'No fee' : fee.fee_type === 'PERCENTAGE' ? `${fee.fee_value}%` : `GHS ${Number(fee.fee_value).toFixed(2)}`}</strong></div>)}</>}
            {financeTransactions.length > 0 && <><h3>Submitted ledger entries</h3>{financeTransactions.map((entry) => <div className="kv-row" key={entry.id}><span>{entry.institution_name} · {entry.external_reference}<small>{entry.product_name} · {entry.transaction_type} · GHS {(Number(entry.amount_cents) / 100).toFixed(2)}</small></span><span className={`status-pill ${String(entry.status).toLowerCase()}`}>{entry.status.toLowerCase().replaceAll('_', ' ')}</span></div>)}</>}
          </section>

          <form className="card" onSubmit={submit}>
            <h2>Set merchant settlement preferences</h2>
            <p className="subtle" style={{ marginTop: -7, marginBottom: 16 }}>
              Changes are restricted to institution policy boundaries and validated by the backend.
            </p>
            {selectedMerchant?.accountSetupStatus !== 'ACTIVE' && selectedMerchant && <p className="policy-hint">Activate your branch first: Eganow account setup is pending.</p>}
            {selectedMerchant?.accountSetupStatus === 'ACTIVE' && selectedLink?.verification_status !== 'APPROVED' && selectedLink && <p className="policy-hint">Verification pending. Split configuration unlocks after the institution approves this link.</p>}
            {!merchants.length || !options.length ? (
              <div className="empty-state">Choose an active merchant and finish institution verification before configuring settlement.</div>
            ) : (
              <>
                <div className="two-col">
                  <div className="field">
                    <label htmlFor="institution-merchant">Merchant</label>
                    <select id="institution-merchant" required value={merchantId} onChange={(event) => setMerchantId(event.target.value)}>
                      <option value="">Select merchant</option>
                      {merchants.map((merchant) => <option key={merchant.id} value={merchant.id}>{merchant.displayName}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="institution-choice">Institution</label>
                    <select id="institution-choice" required value={institutionId} onChange={(event) => setInstitutionId(event.target.value)}>
                      <option value="">Select institution</option>
                      {options.map((option) => <option key={option.institutionId} value={option.institutionId}>{option.institutionName}</option>)}
                    </select>
                  </div>
                </div>
                {selectedOption && (
                  <>
                    <div className="two-col">
                      <div className="field">
                        <label htmlFor="frequency-mode">Settlement mode</label>
                        <select id="frequency-mode" value={frequencyMode} onChange={(event) => setFrequencyMode(event.target.value)}>
                          {allowedModes.map((mode) => <option value={mode} key={mode}>{mode === 'PER_TRANSACTION' ? 'Per transaction' : 'Periodic'}</option>)}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="vendor-mode">Vendor payout timing</label>
                        <select id="vendor-mode" value={vendorPayoutMode} onChange={(event) => setVendorPayoutMode(event.target.value)}>
                          {allowedVendorModes.map((mode) => <option value={mode} key={mode}>{mode === 'PERIODIC' ? 'Periodic' : 'Per transaction'}</option>)}
                        </select>
                      </div>
                    </div>
                    {frequencyMode === 'PERIODIC' && (
                      <div className="two-col">
                        <div className="field">
                          <label htmlFor="schedule-unit">Periodic schedule unit</label>
                          <select id="schedule-unit" value={scheduleUnit} onChange={(event) => setScheduleUnit(event.target.value)}>
                            {['DAYS', 'WEEKS', 'MONTHS', 'YEARS'].map((unit) => <option value={unit} key={unit}>{unit[0] + unit.slice(1).toLowerCase()}</option>)}
                          </select>
                        </div>
                        <div className="field">
                          <label htmlFor="schedule-interval">Every</label>
                          <input id="schedule-interval" type="number" min="1" step="1" required value={scheduleInterval} onChange={(event) => setScheduleInterval(event.target.value)} />
                        </div>
                        <div className="field">
                          <label htmlFor="schedule-anchor">Schedule anchor date</label>
                          <input id="schedule-anchor" type="date" required value={scheduleAnchorDate} onChange={(event) => setScheduleAnchorDate(event.target.value)} />
                        </div>
                        <p className="policy-hint">
                          Policy range: {scheduleText(selectedOption.periodicSchedule?.minimum)} to {scheduleText(selectedOption.periodicSchedule?.maximum)}. The server enforces exact bounds.
                        </p>
                      </div>
                    )}
                    {selectedOption.priorityDeductionAllowed && (
                      <label className="checkbox-field">
                        <input type="checkbox" checked={priorityDeductionSelected} onChange={(event) => setPriorityDeductionSelected(event.target.checked)} />
                        <span>Enable priority deduction for this merchant</span>
                      </label>
                    )}
                  </>
                )}
                <button className="btn btn-primary" disabled={saving || !selectedOption}>{saving ? 'Saving…' : 'Save settlement settings'}</button>
              </>
            )}
          </form>
          <section className="card">
            <h2>Resolved split rules</h2>
            {splitRulesError && <div className="status-banner error" role="alert">{splitRulesError}</div>}
            {splitRules.map((rule) => <div className="kv-row" key={rule.institution_id}>
              <span>
                <strong>{rule.institution_name}</strong>
                {rule.hasRule
                  ? <small>{rule.amount}{rule.type === 'PERCENTAGE' ? '%' : ' GHS'} · {String(rule.mode).replaceAll('_', ' ')} · {rule.scope_level === 'MERCHANT_OVERRIDE' ? 'Merchant override' : 'Tenant default'}</small>
                  : <small>No active split rule; institution policy applies.</small>}
              </span>
              {rule.hasRule && <span className="status-pill approved">Effective</span>}
            </div>)}
            {!selectedMerchant && <p className="subtle">Select your branch above to configure its split.</p>}
            {selectedMerchant && selectedMerchant.accountSetupStatus !== 'ACTIVE' && <p className="policy-hint">Activate your branch first before setting a split.</p>}
            {selectedMerchant?.accountSetupStatus === 'ACTIVE' && !selectedOption && <p className="policy-hint">An approved institution link and saved settlement schedule are required first.</p>}
            {['TENANT_ADMIN', 'TENANT_MANAGER'].includes(user.role) && <form onSubmit={submitDefaultSplitRule}>
              <h3>Tenant default</h3>
              <p className="subtle">This rule applies to linked merchants unless a merchant-specific override is saved.</p>
              <div className="two-col">
                <div className="field"><label htmlFor="default-rule-institution">Institution</label>
                  <select id="default-rule-institution" required value={institutionId} onChange={(event) => setInstitutionId(event.target.value)}>
                    <option value="">Select institution</option>
                    {options.map((option) => <option value={option.institutionId} key={option.institutionId}>{option.institutionName}</option>)}
                  </select>
                </div>
                <div className="field"><label htmlFor="default-rule-type">Split type</label>
                  <select id="default-rule-type" value={defaultSplitType} onChange={(event) => { setDefaultSplitType(event.target.value); setDefaultSplitAmount('') }}>
                    <option value="PERCENTAGE">Percentage</option><option value="FIXED">Fixed amount</option>
                  </select>
                </div>
                <div className="field"><label htmlFor="default-rule-amount">{defaultSplitType === 'PERCENTAGE' ? 'Percentage' : 'Amount (GHS)'}</label>
                  <input id="default-rule-amount" type="number" min={selectedOption?.splitBounds?.[defaultSplitType === 'PERCENTAGE' ? 'percentage' : 'fixed']?.minimum ?? 0} max={selectedOption?.splitBounds?.[defaultSplitType === 'PERCENTAGE' ? 'percentage' : 'fixed']?.maximum ?? undefined} step="0.01" required value={defaultSplitAmount} onChange={(event) => setDefaultSplitAmount(event.target.value)} />
                </div>
                <div className="field"><label htmlFor="default-rule-mode">Split mode</label>
                  <select id="default-rule-mode" value={defaultSplitMode} onChange={(event) => setDefaultSplitMode(event.target.value)}>
                    {(selectedOption ? optionFrequencyModes(selectedOption) : ['PER_TRANSACTION', 'PERIODIC']).map((mode) => <option value={mode} key={mode}>{mode === 'PER_TRANSACTION' ? 'Per transaction' : 'Periodic'}</option>)}
                  </select>
                </div>
                {defaultSplitMode === 'PERIODIC' && <>
                  <div className="field"><label htmlFor="default-schedule-unit">Schedule unit</label>
                    <select id="default-schedule-unit" value={defaultScheduleUnit} onChange={(event) => setDefaultScheduleUnit(event.target.value)}>
                      {['DAYS', 'WEEKS', 'MONTHS', 'YEARS'].map((unit) => <option value={unit} key={unit}>{unit[0] + unit.slice(1).toLowerCase()}</option>)}
                    </select>
                  </div>
                  <div className="field"><label htmlFor="default-schedule-interval">Every</label>
                    <input id="default-schedule-interval" type="number" min="1" step="1" required value={defaultScheduleInterval} onChange={(event) => setDefaultScheduleInterval(event.target.value)} />
                  </div>
                </>}
              </div>
              {selectedOption?.priorityDeductionAllowed && <label className="checkbox-field">
                <input type="checkbox" checked={defaultPriorityFirst} onChange={(event) => setDefaultPriorityFirst(event.target.checked)} />
                <span>Deduct institution share first</span>
              </label>}
              <button className="btn btn-primary" disabled={saving || !selectedOption}>{saving ? 'Saving…' : 'Save tenant default'}</button>
            </form>}
            {selectedMerchant?.accountSetupStatus === 'ACTIVE' && selectedOption && <form onSubmit={submitSplitRule}>
              <div className="two-col">
                <div className="field"><label htmlFor="split-institution">Institution</label>
                  <select id="split-institution" required value={institutionId} onChange={(event) => setInstitutionId(event.target.value)}>
                    {options.map((option) => <option value={option.institutionId} key={option.institutionId}>{option.institutionName}</option>)}
                  </select>
                </div>
                <div className="field"><label htmlFor="split-type">Split type</label>
                  <select id="split-type" value={splitType} onChange={(event) => { setSplitType(event.target.value); setSplitAmount('') }}>
                    <option value="PERCENTAGE">Percentage</option><option value="FIXED">Fixed amount</option>
                  </select>
                </div>
                <div className="field"><label htmlFor="split-amount">{splitType === 'PERCENTAGE' ? 'Percentage' : 'Amount (GHS)'}</label>
                  <input id="split-amount" type="number" min={selectedOption.splitBounds?.[splitType === 'PERCENTAGE' ? 'percentage' : 'fixed']?.minimum ?? 0} max={selectedOption.splitBounds?.[splitType === 'PERCENTAGE' ? 'percentage' : 'fixed']?.maximum ?? undefined} step="0.01" required value={splitAmount} onChange={(event) => setSplitAmount(event.target.value)} />
                  <small>Institution limit: {selectedOption.splitBounds?.[splitType === 'PERCENTAGE' ? 'percentage' : 'fixed']?.minimum ?? '—'} to {selectedOption.splitBounds?.[splitType === 'PERCENTAGE' ? 'percentage' : 'fixed']?.maximum ?? '—'}</small>
                </div>
              </div>
              <button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save split'}</button>
            </form>}
          </section>
        </>
      )}
      <div className="footer-note">Split-rule writes and resolved-rule reads are validated by the tenant API against institution link boundaries and settlement policy.</div>
    </div>
  )
}
