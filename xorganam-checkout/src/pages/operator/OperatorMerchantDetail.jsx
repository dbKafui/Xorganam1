import { useEffect, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { operatorApi } from '../../api/client'

function money(n) {
  return Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function OperatorMerchantDetail() {
  const { merchantId } = useParams()
  const [merchant, setMerchant] = useState(null)
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editForm, setEditForm] = useState(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    operatorApi.getMerchant(merchantId).then((m) => { setMerchant(m); setEditForm(m) }).catch((err) => setError(err.message))
    operatorApi.merchantReport(merchantId).then(setReport).catch(() => {})
  }, [merchantId])

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
    setError('')
    setNotice('')
    try {
      await operatorApi.updateMerchantSettings(merchantId, { allowManualControl: !merchant.allowManualControl })
      setNotice('Manual control setting updated.')
      load()
    } catch (err) {
      setError(err.message)
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
          <p>{merchant.payoutMode === 'AUTO_SWEEP' ? 'Collect for me' : 'Collection only'} · Eganow accounts on file</p>
        </div>
        <Link to="/operator/merchants" className="btn btn-secondary">Back to merchants</Link>
      </div>

      {error && <div className="status-banner error"><span className="status-icon">⚠</span><span>{error}</span></div>}
      {notice && <div className="status-banner success"><span className="status-icon">✓</span><span>{notice}</span></div>}

      {report && (
        <div className="metrics-row">
          <div className="metric"><div className="label">Total collected</div><div className="value">GHS {money(report.totalCollected)}</div></div>
          <div className="metric"><div className="label">Total paid out</div><div className="value">GHS {money(report.totalPaidOut)}</div></div>
          <div className="metric"><div className="label">Transactions</div><div className="value">{report.collectionCount}</div></div>
        </div>
      )}

      <div className="card">
        <h2>Manual control</h2>
        <p style={{ fontSize: 13, marginBottom: 12 }}>
          {merchant.payoutMode === 'AUTO_SWEEP'
            ? "This merchant is on Collect for me — her money moves automatically. Granting manual control lets her (or your staff) still trigger a transfer/payout by hand if needed."
            : 'This merchant is on Collection only — manual control is how her money actually moves.'}
        </p>
        <div className="kv-row">
          <span>Allow manual control</span>
          <button className="btn btn-secondary btn-sm" onClick={toggleManualControl}>
            {merchant.allowManualControl ? 'Enabled — click to disable' : 'Disabled — click to enable'}
          </button>
        </div>
      </div>

      <form className="card" onSubmit={saveDetails}>
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
              <option value="MTN">MTN</option>
              <option value="Vodafone">Vodafone</option>
              <option value="AirtelTigo">AirtelTigo</option>
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
      </form>

      <div className="card">
        <h2>Payment link</h2>
        <p style={{ fontSize: 13, marginBottom: 8 }}>Share this link for customers to pay {merchant.displayName} directly:</p>
        <div className="kv-row">
          <span className="mono" style={{ wordBreak: 'break-all' }}>{window.location.origin}/?merchant={merchant.id}</span>
        </div>
      </div>
    </div>
  )
}
