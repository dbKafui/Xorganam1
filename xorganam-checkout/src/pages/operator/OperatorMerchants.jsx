import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'

export default function OperatorMerchants() {
  const { user } = useOperatorAuth()
  const [merchants, setMerchants] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user?.tenantId) return
    operatorApi
      .listMerchants(user.tenantId)
      .then(setMerchants)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [user])

  return (
    <div>
      <div className="portal-header">
        <div>
          <h1>Merchants</h1>
          <p>The market women you collect payments on behalf of.</p>
        </div>
        <Link to="/operator/merchants/new" className="btn btn-primary">Add a merchant</Link>
      </div>

      {error && <div className="status-banner error"><span className="status-icon">⚠</span><span>{error}</span></div>}

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : merchants.length === 0 ? (
          <div className="empty-state">No merchants yet. Add your first one to start collecting payments.</div>
        ) : (
          <table className="ledger">
            <thead>
              <tr><th>Name</th><th>MoMo number</th><th>Network</th><th>Payout mode</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {merchants.map((m) => (
                <tr key={m.id}>
                  <td>{m.displayName}</td>
                  <td className="mono">{m.mobileMoneyNumber}</td>
                  <td>{m.networkProvider}</td>
                  <td>{m.payoutMode === 'AUTO_SWEEP' ? 'Collect for me' : 'Collection only'}</td>
                  <td><span className={`status-pill ${m.isActive ? 'approved' : 'rejected'}`}>{m.isActive ? 'Active' : 'Inactive'}</span></td>
                  <td><Link to={`/operator/merchants/${m.id}`}>Manage →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
