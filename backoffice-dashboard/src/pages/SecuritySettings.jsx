import { useEffect, useState } from 'react'
import { platformSecurityApi } from '../api/auth'

export default function SecuritySettings() {
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    platformSecurityApi.getMfaExemptions()
      .then((result) => setAccounts(result.accounts))
      .catch((requestError) => setError(requestError.message || 'Could not load security settings.'))
      .finally(() => setLoading(false))
  }, [])

  async function setExemption(account, exempt) {
    const key = `${account.type}:${account.id}`
    setSavingId(key)
    setError('')
    setNotice('')
    try {
      const result = await platformSecurityApi.updateMfaExemption(account, exempt)
      setAccounts((current) => current.map((item) => item.id === account.id && item.type === account.type
        ? { ...item, mfaExempt: result.mfaExempt }
        : item))
      setNotice(`MFA exemption ${result.mfaExempt ? 'enabled' : 'removed'}. The account must sign in again for the change to apply.`)
    } catch (requestError) {
      setError(requestError.message || 'Could not save security settings.')
    } finally {
      setSavingId('')
    }
  }

  return (
    <section>
      <header className="page-header">
        <div><div className="eyebrow">PLATFORM CONTROLS</div><h1>Security settings</h1></div>
      </header>
      <div className="panel security-settings-panel">
        <h2>Authenticator MFA</h2>
        <p>MFA remains required for all regular users. For local testing, the platform admin can exempt only accounts in the reserved <code>@xorganam.test</code> domain.</p>
        <p>MFA enrollment encrypts authenticator secrets through Vault. Vault must be reachable before removing a demo account exemption.</p>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {notice && <div className="alert" role="status">{notice}</div>}
        {loading ? <p>Loading demo accounts…</p> : accounts.length === 0 ? <p>No <code>@xorganam.test</code> accounts found.</p> : <div className="security-demo-list">
          {accounts.map((account) => {
            const key = `${account.type}:${account.id}`
            return <label className="security-policy-option" key={key}>
              <input type="checkbox" checked={account.mfaExempt} disabled={savingId === key}
                onChange={(event) => setExemption(account, event.target.checked)} />
              <span><strong>{account.email}</strong><small>{account.role.replaceAll('_', ' ')} · {account.type.toLowerCase()} account</small></span>
            </label>
          })}
        </div>}
      </div>
    </section>
  )
}
