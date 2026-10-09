import { useEffect, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { operatorApi } from '../../api/client'
import { useOperatorAuth } from '../../context/OperatorAuthContext'

function money(n) {
  return Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function OperatorMerchantDetail() {
  const { user } = useOperatorAuth()
  const { merchantId } = useParams()
  const [merchant, setMerchant] = useState(null)
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editForm, setEditForm] = useState(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    operatorApi.getMerchant(merchantId).then((m) => { setMerchant(m); setEditForm(m) }).catch((err) => setError(err.message))
    if (user?.role !== 'TENANT_BRANCH_MANAGER') operatorApi.merchantReport(merchantId).then(setReport).catch(() => {})
  }, [merchantId, user?.role])

  useEffect(() => {
    load()
  }, [load])

  async function saveDetails(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    setSaving(true)
    try {
      await operatorApi.updateMerchant(merchantId, {
        displayName: editForm.displayName,
        mobileMoneyNumber: editForm.mobileMoneyNumber,
        networkProvider: editForm.networkProvider,
        payoutMode: editForm.payoutMode,
        isActive: editForm.isActive
      })
      setNotice('Merchant details updated.')
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function toggleManualControl() {
    const willEnable = !merchant.allowManualControl
    if (!window.confirm(`${willEnable ? 'Enable' : 'Disable'} manual release for ${merchant.displayName}? Authorized staff will be able to trigger transfers manually.`)) return
    setError('')
    setNotice('')
    setSaving(true)
    try {
      await operatorApi.updateMerchantSettings(merchantId, { allowManualControl: willEnable })
      setNotice('Manual control setting updated.')
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function saveNotificationSettings(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setSaving(true)
    try {
      const settings = await operatorApi.updateMerchantSettings(merchantId, {
        notifySms: Boolean(editForm.notifySms),
        notifyEmail: Boolean(editForm.notifyEmail),
        contactEmail: editForm.contactEmail || ''
      })
      setMerchant((current) => ({ ...current, ...settings }))
      setEditForm((current) => ({ ...current, ...settings }))
      setNotice('Notification preferences updated.')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (!merchant || !editForm) {
    return <div className="empty-state">{error || 'Loading…'}</div>
  }

  return (
    <div>
      <div className="portal-header">
        <div>
          <h1>{merchant.displayName}</h1>
          <p className="mono">Vendor reference: {merchant.vendorReference}</p>
          <p>{merchant.payoutMode === 'AUTO_SWEEP' ? 'We move your money automatically' : 'You control when it moves'}</p>
        </div>
        <Link to="/operator/merchants" className="btn btn-secondary">Back to merchants</Link>
      </div>

      {error && <div className="status-banner error"><span className="status-icon">⚠</span><span>{error}</span></div>}
      {notice && <div className="status-banner success"><span className="status-icon">✓</span><span>{notice}</span></div>}
      {merchant.accountSetupStatus !== 'ACTIVE' && (
        <div className="status-banner error" role="status">
          <span className="status-icon">!</span><span>Eganow account setup is pending. This branch cannot collect or pay out until platform operations completes setup.</span>
        </div>
      )}

      {report && (
        <div className="metrics-row">
          <div className="metric"><div className="label">Total collected</div><div className="value">GHS {money(report.totalCollected)}</div></div>
          <div className="metric"><div className="label">Total paid out</div><div className="value">GHS {money(report.totalPaidOut)}</div></div>
          <div className="metric"><div className="label">Transactions</div><div className="value">{report.collectionCount}</div></div>
        </div>
      )}

      <div className="card">
        <h2>How you get paid</h2>
        <p style={{ fontSize: 13, marginBottom: 12 }}>
          {merchant.payoutMode === 'AUTO_SWEEP'
            ? 'We move your money automatically. Allow manual release to let authorized staff trigger a transfer by hand when needed.'
            : 'Collected money waits for an authorized person to release it manually.'}
        </p>
        <div className="kv-row">
          <span>Allow manual release even in automatic mode</span>
          {user?.role === 'TENANT_BRANCH_MANAGER'
            ? <strong>{merchant.allowManualControl ? 'Enabled' : 'Disabled'}</strong>
            : <button className="btn btn-secondary btn-sm" disabled={saving} onClick={toggleManualControl}>{saving ? 'Updating…' : merchant.allowManualControl ? 'Enabled — click to disable' : 'Disabled — click to enable'}</button>}
        </div>
      </div>

      {user?.role !== 'TENANT_BRANCH_MANAGER' && <form className="card" onSubmit={saveDetails}>
        <h2>Details</h2>
        <div className="two-col">
          <div className="field">
            <label>Name</label>
            <input value={editForm.displayName} onChange={(e) => setEditForm((f) => ({ ...f, displayName: e.target.value }))} />
          </div>
          <div className="field">
            <label>Mobile money number</label>
            <input value={editForm.mobileMoneyNumber} onChange={(e) => setEditForm((f) => ({ ...f, mobileMoneyNumber: e.target.value }))} />
          </div>
        </div>
        <div className="two-col">
          <div className="field">
            <label>Network</label>
            <select value={editForm.networkProvider} onChange={(e) => setEditForm((f) => ({ ...f, networkProvider: e.target.value }))}>
              <option value="MTNGH">MTN</option>
              <option value="TCELGH">Vodafone</option>
              <option value="ATGH">AirtelTigo</option>
            </select>
          </div>
          <div className="field">
            <label>Payout mode</label>
            <select value={editForm.payoutMode} onChange={(e) => setEditForm((f) => ({ ...f, payoutMode: e.target.value }))}>
              <option value="AUTO_SWEEP">Collect for me</option>
              <option value="MANUAL">Collection only</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label>Status</label>
          <select value={editForm.isActive} onChange={(e) => setEditForm((f) => ({ ...f, isActive: e.target.value === 'true' }))}>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        </div>
        <button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
      </form>}

      {user?.role !== 'TENANT_BRANCH_MANAGER' && <form className="card" onSubmit={saveNotificationSettings}>
        <h2>Payment notifications</h2>
        <div className="field">
          <label><input type="checkbox" checked={Boolean(editForm.notifySms)} onChange={(event) => setEditForm((current) => ({ ...current, notifySms: event.target.checked }))} /> Send SMS payment updates</label>
        </div>
        <div className="field">
          <label><input type="checkbox" checked={Boolean(editForm.notifyEmail)} onChange={(event) => setEditForm((current) => ({ ...current, notifyEmail: event.target.checked }))} /> Send email payment updates</label>
        </div>
        <div className="field">
          <label htmlFor="merchant-notification-email">Notification email</label>
          <input id="merchant-notification-email" type="email" maxLength={255} required={Boolean(editForm.notifyEmail)} disabled={!editForm.notifyEmail} value={editForm.contactEmail || ''} onChange={(event) => setEditForm((current) => ({ ...current, contactEmail: event.target.value }))} />
        </div>
        <button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save notification preferences'}</button>
      </form>}

      <div className="card">
        <h2>Payment link</h2>
        <p style={{ fontSize: 13, marginBottom: 8 }}>Share this link for customers to pay {merchant.displayName} directly:</p>
        <div className="kv-row">
          <span className="mono" style={{ wordBreak: 'break-all' }}>{window.location.origin}/?merchant={merchant.id}</span>
          <button className="btn btn-secondary btn-sm" type="button" onClick={async () => {
            await navigator.clipboard.writeText(`${window.location.origin}/?merchant=${merchant.id}`)
            setNotice('Payment link copied.')
          }}>Copy link</button>
        </div>
      </div>
    </div>
  )
}
