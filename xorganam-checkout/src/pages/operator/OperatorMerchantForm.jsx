import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'

const initialForm = {
  displayName: '',
  mobileMoneyNumber: '',
  networkProvider: 'MTNGH',
  payoutMode: 'AUTO_SWEEP',
}

export default function OperatorMerchantForm() {
  const { user } = useOperatorAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState(initialForm)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  function set(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      const created = await operatorApi.createMerchant({ tenantId: user.tenantId, ...form })
      navigate(`/operator/merchants/${created.id}`, { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="portal-header">
        <div>
          <h1>Add a merchant</h1>
          <p>Add a branch now. Platform operations will connect its Eganow accounts before it can accept payments.</p>
        </div>
        <Link to="/operator/merchants" className="btn btn-secondary">Back to merchants</Link>
      </div>

      <form className="card" onSubmit={handleSubmit}>
        {error && <div className="status-banner error"><span className="status-icon">⚠</span><span>{error}</span></div>}

        <div className="field">
          <label>Merchant name</label>
          <input required value={form.displayName} onChange={set('displayName')} placeholder="e.g. Ama's Provisions" />
        </div>

        <div className="two-col">
          <div className="field">
            <label>Mobile money number</label>
            <input required value={form.mobileMoneyNumber} onChange={set('mobileMoneyNumber')} placeholder="0551234567" />
          </div>
          <div className="field">
            <label>Network</label>
            <select value={form.networkProvider} onChange={set('networkProvider')}>
              <option value="MTNGH">MTN</option>
              <option value="TCELGH">Vodafone</option>
              <option value="ATGH">AirtelTigo</option>
            </select>
          </div>
        </div>

        <div className="field">
          <label>Payout mode</label>
          <select value={form.payoutMode} onChange={set('payoutMode')}>
            <option value="AUTO_SWEEP">Collect for me — automatic transfer + payout</option>
            <option value="MANUAL">Collection only — I'll move the money manually</option>
          </select>
        </div>

        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: -8, marginBottom: 16 }}>
          This branch will appear in your dashboard immediately. Collections and payouts stay unavailable until platform operations completes account setup.
        </p>

        <button className="btn btn-primary" disabled={saving}>{saving ? 'Adding…' : 'Add merchant'}</button>
      </form>
    </div>
  )
}
