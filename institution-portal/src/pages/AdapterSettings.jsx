import { useEffect, useState } from 'react'
import { institutionApi } from '../api/client.js'
import PageHeader from '../components/PageHeader.jsx'
import { ErrorMessage, LoadingState, SuccessMessage } from '../components/Feedback.jsx'

const emptyConfig = {
  adapterType: 'GENERIC_REST',
  baseUrl: '',
  authType: 'NONE',
  secretReference: '',
  requestTemplate: '{\n  "method": "GET",\n  "path": "/members/{memberId}/status"\n}',
  responseActivePath: '',
  responseDetailPath: '',
  customAdapterKey: ''
}

function configToForm(config) {
  if (!config) return emptyConfig
  return {
    adapterType: config.adapter_type || 'GENERIC_REST',
    baseUrl: config.base_url || '',
    authType: config.auth_type || 'NONE',
    secretReference: typeof config.auth_config?.secretRef === 'string' ? config.auth_config.secretRef : '',
    requestTemplate: JSON.stringify(config.request_template || {}, null, 2),
    responseActivePath: config.response_active_path || '',
    responseDetailPath: config.response_detail_path || '',
    customAdapterKey: config.custom_adapter_key || ''
  }
}

export default function AdapterSettings() {
  const [form, setForm] = useState(emptyConfig)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    institutionApi.getAdapterConfig()
      .then((config) => setForm(configToForm(config)))
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false))
  }, [])

  async function submit(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    let requestTemplate
    try {
      requestTemplate = JSON.parse(form.requestTemplate)
    } catch {
      setError('Request template must be valid JSON.')
      return
    }
    if (!requestTemplate || typeof requestTemplate !== 'object' || Array.isArray(requestTemplate)) {
      setError('Request template must be a JSON object.')
      return
    }
    if (form.adapterType === 'GENERIC_REST') {
      try {
        const parsed = new URL(form.baseUrl)
        if (parsed.protocol !== 'https:') {
          setError('Generic adapter URLs must use HTTPS.')
          return
        }
      } catch {
        setError('Enter a valid HTTPS base URL.')
        return
      }
    }
    if (form.authType !== 'NONE' && !form.secretReference.trim()) {
      setError('Enter a secrets-manager reference for the selected authentication mode.')
      return
    }
    setSaving(true)
    try {
      await institutionApi.saveAdapterConfig({
        adapterType: form.adapterType,
        baseUrl: form.adapterType === 'GENERIC_REST' ? form.baseUrl : null,
        authType: form.authType,
        authConfig: form.authType === 'NONE' ? null : { secretRef: form.secretReference.trim() },
        requestTemplate,
        responseActivePath: form.responseActivePath || null,
        responseDetailPath: form.responseDetailPath || null,
        customAdapterKey: form.adapterType === 'CUSTOM' ? form.customAdapterKey : null
      })
      setNotice('Membership adapter settings saved.')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <><PageHeader eyebrow="INSTITUTION / SETTINGS" title="API adapter" description="Configure the membership lookup shape for your institution." /><LoadingState /></>

  return (
    <>
      <PageHeader eyebrow="INSTITUTION / SETTINGS" title="Membership API adapter" description="Configure the connection contract used for API-based membership verification." />
      <ErrorMessage>{error}</ErrorMessage><SuccessMessage>{notice}</SuccessMessage>
      <section className="surface settings-surface">
        <div className="security-callout"><strong>Credential safety</strong><span>Never enter API keys, passwords, or bearer tokens here. Store credentials in the secrets manager and enter only the secret reference.</span></div>
        <form className="form-grid" onSubmit={submit}>
          <label className="form-field"><span>Adapter type</span><select value={form.adapterType} onChange={(event) => setForm({ ...form, adapterType: event.target.value })}><option value="GENERIC_REST">Generic REST</option><option value="CUSTOM">Custom integration</option></select></label>
          <label className="form-field"><span>Authentication mode</span><select value={form.authType} onChange={(event) => setForm({ ...form, authType: event.target.value })}><option value="NONE">None</option><option value="API_KEY">API key (secret reference required)</option><option value="BEARER">Bearer (secret reference required)</option><option value="BASIC">Basic (secret reference required)</option></select></label>
          {form.adapterType === 'GENERIC_REST' ? <label className="form-field form-span"><span>HTTPS base URL</span><input type="url" required placeholder="https://membership.example.org/api" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /></label> : <label className="form-field form-span"><span>Custom adapter key</span><input required placeholder="registered-adapter-name" value={form.customAdapterKey} onChange={(event) => setForm({ ...form, customAdapterKey: event.target.value })} /></label>}
          {form.authType !== 'NONE' && <label className="form-field form-span"><span>Secrets environment-variable name</span><input required pattern="[A-Z][A-Z0-9_]{2,127}" placeholder="INSTITUTION_MEMBERSHIP_API_KEY" value={form.secretReference} onChange={(event) => setForm({ ...form, secretReference: event.target.value.toUpperCase() })} /><small>Only this uppercase environment variable name is stored. The deployed API process must receive the secret value.</small></label>}
          <label className="form-field form-span"><span>Request template (JSON)</span><textarea required rows="6" spellCheck="false" className="code-input" value={form.requestTemplate} onChange={(event) => setForm({ ...form, requestTemplate: event.target.value })} /></label>
          <label className="form-field"><span>Response active path</span><input placeholder="data.membership.active" value={form.responseActivePath} onChange={(event) => setForm({ ...form, responseActivePath: event.target.value })} /></label>
          <label className="form-field"><span>Response detail path</span><input placeholder="data.membership.status" value={form.responseDetailPath} onChange={(event) => setForm({ ...form, responseDetailPath: event.target.value })} /></label>
          <div className="form-span form-actions"><button className="button button-primary" disabled={saving}>{saving ? 'Saving...' : 'Save adapter settings'} <span>→</span></button></div>
        </form>
      </section>
      <p className="footnote">Generic REST checks run when a tenant submits a membership claim. Configure response paths to a boolean or recognizable membership status, and enable API verification for this institution.</p>
    </>
  )
}
