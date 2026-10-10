import { useCallback, useEffect, useState } from 'react'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'
import { EMAIL_SETTINGS_MESSAGES as M } from '../../constants/emailSettingsMessages'

function providerFieldLabel(key) {
  return key.replace(/([A-Z])/g, ' $1').replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
}

function emptyForm(providerType = '') {
  return { providerType, settings: {}, secrets: {}, fromAddress: '', fromName: '', replyTo: '', enabled: false }
}

export default function OperatorEmailSettings() {
  const { user } = useOperatorAuth()
  const canManage = ['TENANT_ADMIN', 'TENANT_MANAGER'].includes(user?.role)
  const [providers, setProviders] = useState([])
  const [savedConfig, setSavedConfig] = useState(null)
  const [form, setForm] = useState(emptyForm())
  const [challenge, setChallenge] = useState(null)
  const [delivery, setDelivery] = useState(null)
  const [errors, setErrors] = useState([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [testing, setTesting] = useState(false)
  const [checkingDelivery, setCheckingDelivery] = useState(false)

  const load = useCallback(async () => {
    if (!user?.tenantId) return
    setLoading(true)
    setError('')
    try {
      const [providerResult, configResult] = await Promise.all([
        operatorApi.getTenantEmailProviders(user.tenantId),
        operatorApi.getTenantEmailConfig(user.tenantId)
      ])
      const providerRows = Array.isArray(providerResult?.providers) ? providerResult.providers : []
      const config = configResult?.config || null
      setProviders(providerRows)
      setSavedConfig(config)
      setForm(config ? {
        providerType: config.providerType,
        settings: config.settings || {},
        secrets: {},
        fromAddress: config.fromAddress || '',
        fromName: config.fromName || '',
        replyTo: config.replyTo || '',
        enabled: Boolean(config.enabled)
      } : emptyForm(providerRows[0]?.type || ''))
    } catch (requestError) {
      setError(requestError.message || M.unavailable)
    } finally {
      setLoading(false)
    }
  }, [user?.tenantId])

  useEffect(() => { load() }, [load])

  const selectedProvider = providers.find((provider) => provider.type === form.providerType)
  const addressUnchanged = savedConfig?.fromAddress?.toLowerCase() === form.fromAddress.trim().toLowerCase()
  const senderVerified = Boolean(savedConfig?.senderVerified && addressUnchanged)

  function updateSetting(key, value) {
    setForm((current) => ({ ...current, settings: { ...current.settings, [key]: value } }))
  }

  function selectProvider(providerType) {
    setForm((current) => ({ ...emptyForm(providerType), fromAddress: current.fromAddress, fromName: current.fromName, replyTo: current.replyTo }))
    setChallenge(null)
    setErrors([])
  }

  async function saveConfig(event) {
    event.preventDefault()
    setSaving(true)
    setError('')
    setNotice('')
    setErrors([])
    try {
      const result = await operatorApi.saveTenantEmailConfig(user.tenantId, {
        ...form,
        enabled: senderVerified && form.enabled
      })
      const config = result.config || null
      setSavedConfig(config)
      setForm((current) => ({ ...current, enabled: Boolean(config?.enabled), secrets: {} }))
      setChallenge(result.verificationChallenge || null)
      setNotice(M.saved)
    } catch (requestError) {
      setError(requestError.message || M.invalidConfiguration)
      setErrors(Array.isArray(requestError.details) ? requestError.details : [])
    } finally {
      setSaving(false)
    }
  }

  async function requestChallenge() {
    setError('')
    setNotice('')
    setVerifying(true)
    try {
      const result = await operatorApi.requestEmailSenderVerification(user.tenantId)
      setChallenge(result.verificationChallenge)
      setNotice(result.message || '')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setVerifying(false)
    }
  }

  async function confirmVerification() {
    setError('')
    setNotice('')
    setVerifying(true)
    try {
      const result = await operatorApi.confirmEmailSenderVerification(user.tenantId)
      setNotice(result.message || M.senderVerified)
      setChallenge(null)
      await load()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setVerifying(false)
    }
  }

  async function sendTest() {
    setError('')
    setNotice('')
    setTesting(true)
    setDelivery(null)
    try {
      const result = await operatorApi.sendTenantEmailTest(user.tenantId)
      setDelivery({ id: result.deliveryId, status: result.status, attempt_count: 0 })
      setNotice(result.message || M.queued)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setTesting(false)
    }
  }

  async function refreshDelivery() {
    if (!delivery?.id) return
    setCheckingDelivery(true)
    setError('')
    try {
      setDelivery(await operatorApi.getTenantEmailTestStatus(user.tenantId, delivery.id))
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setCheckingDelivery(false)
    }
  }

  async function copyValue(value) {
    try {
      await navigator.clipboard.writeText(value)
      setNotice(M.copied)
    } catch {
      setError(M.copy)
    }
  }

  if (!canManage) return <div className="status-banner error" role="alert">{M.forbidden}</div>
  if (loading) return <div className="empty-state">{M.loading}</div>

  return <div className="email-settings-page">
    <div className="portal-header">
      <div><span className="eyebrow-label">ADMINISTRATION / DELIVERY</span><h1>{M.title}</h1><p>{M.subtitle}</p></div>
      <button type="button" className="btn btn-secondary" onClick={load} disabled={saving || verifying || testing}>{M.refresh || 'Refresh'}</button>
      <button type="button" className="btn btn-secondary" onClick={load} disabled={saving || verifying || testing}>{M.refresh}</button>
    </div>
    {error && <div className="status-banner error" role="alert">{error}</div>}
    {notice && <div className="status-banner success" role="status">{notice}</div>}
    {!providers.length ? <div className="empty-state">{M.noProviders}</div> : <>
      <form className="card email-config-form" onSubmit={saveConfig}>
        <div className="email-section-heading"><div><h2>{M.configTitle}</h2><p>{M.enabledHelp}</p></div><span className={`status-pill ${senderVerified ? 'approved' : 'pending'}`}>{senderVerified ? M.senderVerified : M.senderUnverified}</span></div>
        <div className="email-settings-grid">
          <div className="field"><label htmlFor="tenant-email-provider">{M.provider}</label><select id="tenant-email-provider" value={form.providerType} onChange={(event) => selectProvider(event.target.value)}>{providers.map((provider) => <option key={provider.type} value={provider.type}>{provider.label}</option>)}</select></div>
          <div className="field"><label htmlFor="tenant-email-from">{M.fromAddress}</label><input id="tenant-email-from" type="email" maxLength={255} required value={form.fromAddress} onChange={(event) => { setForm((current) => ({ ...current, fromAddress: event.target.value, enabled: false })); setChallenge(null) }} /></div>
          <div className="field"><label htmlFor="tenant-email-from-name">{M.fromName}</label><input id="tenant-email-from-name" maxLength={255} value={form.fromName} onChange={(event) => setForm((current) => ({ ...current, fromName: event.target.value }))} /></div>
          <div className="field"><label htmlFor="tenant-email-reply-to">{M.replyTo}</label><input id="tenant-email-reply-to" type="email" maxLength={255} value={form.replyTo} onChange={(event) => setForm((current) => ({ ...current, replyTo: event.target.value }))} /></div>
        </div>
        {selectedProvider && <div className="email-provider-fields">
          <h3>{selectedProvider.label}</h3>
          <div className="email-settings-grid">
            {selectedProvider.fields.map((field) => {
              const id = `tenant-email-${field.key}`
              const isConfigured = Boolean(savedConfig?.providerType === form.providerType && savedConfig.secrets?.[field.key])
              const value = field.secret ? form.secrets[field.key] || '' : form.settings[field.key] ?? ''
              const required = field.required && (!field.secret || !isConfigured)
              return <div className="field" key={field.key}>
                <label htmlFor={id}>{providerFieldLabel(field.key)} <small>{required ? M.required : M.optional}</small></label>
                {field.input === 'select' ? <select id={id} required={required} value={value} onChange={(event) => updateSetting(field.key, event.target.value)}><option value="" />{(field.options || []).map((option) => <option value={option} key={option}>{option}</option>)}</select> : <input id={id} type={field.secret ? 'password' : field.input} inputMode={field.input === 'number' ? 'numeric' : undefined} autoComplete={field.secret ? 'new-password' : undefined} required={required} placeholder={field.secret ? isConfigured ? M.configured : M.enterSecret : ''} value={value} onChange={(event) => field.secret ? setForm((current) => ({ ...current, secrets: { ...current.secrets, [field.key]: event.target.value } })) : updateSetting(field.key, field.input === 'number' ? event.target.value : event.target.value)} />}
                {errors.filter((issue) => issue.path === `settings.${field.key}` || issue.path === `secrets.${field.key}`).map((issue, index) => <small className="email-field-error" key={index}>{issue.message}</small>)}
              </div>
            })}
          </div>
        </div>}
        {errors.length > 0 && <div className="email-validation-summary" role="alert"><strong>{M.validationTitle}</strong><ul>{errors.map((issue, index) => <li key={`${issue.path}-${index}`}>{issue.path}: {issue.message}</li>)}</ul></div>}
        <div className="email-settings-actions">
          <label className="email-enabled-toggle"><input type="checkbox" checked={Boolean(form.enabled)} disabled={!senderVerified} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} /><span><strong>{M.enabled}</strong><small>{M.enabledHelp}</small></span></label>
          <button className="btn btn-primary" disabled={saving}>{saving ? M.saving : M.save}</button>
        </div>
      </form>

      <section className="card email-verification-section">
        <div className="email-section-heading"><div><h2>{M.challengeTitle}</h2><p>{M.challengeHelp}</p></div><span className={`status-pill ${senderVerified ? 'approved' : 'pending'}`}>{senderVerified ? M.senderVerified : M.senderUnverified}</span></div>
        {!senderVerified && <div className="email-settings-actions"><button type="button" className="btn btn-secondary" disabled={!form.fromAddress || saving || verifying} onClick={requestChallenge}>{verifying ? M.checkingDomain : M.requestRecord}</button>{challenge && <button type="button" className="btn btn-primary" disabled={verifying} onClick={confirmVerification}>{verifying ? M.checkingDomain : M.confirmDomain}</button>}</div>}
          {!senderVerified && <div className="email-settings-actions"><button type="button" className="btn btn-secondary" disabled={!savedConfig || !addressUnchanged || saving || verifying} onClick={requestChallenge}>{verifying ? M.checkingDomain : M.requestRecord}</button>{challenge && <button type="button" className="btn btn-primary" disabled={verifying} onClick={confirmVerification}>{verifying ? M.checkingDomain : M.confirmDomain}</button>}</div>}
        {challenge && <dl className="email-dns-record">
          <div><dt>{M.dnsRecordType}</dt><dd><span>{challenge.recordType}</span></dd></div>
          <div><dt>{M.dnsRecordName}</dt><dd><code>{challenge.recordName}</code><button type="button" className="btn btn-secondary btn-sm" onClick={() => copyValue(challenge.recordName)}>{M.copy}</button></dd></div>
          <div><dt>{M.dnsRecordValue}</dt><dd><code>{challenge.recordValue}</code><button type="button" className="btn btn-secondary btn-sm" onClick={() => copyValue(challenge.recordValue)}>{M.copy}</button></dd></div>
        </dl>}
      </section>

      <section className="card email-test-section">
        <div className="email-section-heading"><div><h2>{M.testTitle}</h2><p>{M.testHelp}</p></div></div>
        <div className="email-settings-actions"><button type="button" className="btn btn-primary" disabled={!savedConfig?.enabled || !savedConfig?.senderVerified || testing} onClick={sendTest}>{testing ? M.sendingTest : M.sendTest}</button>{delivery?.id && <button type="button" className="btn btn-secondary" disabled={checkingDelivery} onClick={refreshDelivery}>{checkingDelivery ? M.checkingStatus : M.checkStatus}</button>}</div>
        {!savedConfig?.enabled && <small className="email-inline-note">{M.testRequiresEnabled}</small>}
        {delivery && <dl className="email-delivery-result" aria-live="polite">
          <div><dt>{M.deliveryId}</dt><dd><code>{delivery.id}</code></dd></div>
          <div><dt>{M.deliveryStatus}</dt><dd><span className={`status-pill ${String(delivery.status).toLowerCase()}`}>{delivery.status}</span></dd></div>
          <div><dt>{M.attemptCount}</dt><dd>{delivery.attempt_count ?? 0}</dd></div>
          {delivery.error_code && <div><dt>{M.permanentFailure}</dt><dd>{delivery.error_code}</dd></div>}
        </dl>}
        {!delivery && <p className="email-inline-note">{M.noDelivery}</p>}
      </section>
    </>}
  </div>
}