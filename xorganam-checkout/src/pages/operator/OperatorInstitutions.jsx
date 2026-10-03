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
