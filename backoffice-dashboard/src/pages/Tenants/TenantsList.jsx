import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { tenantsApi } from '../../api/tenants'
import StatusChip from '../../components/StatusChip'

export default function TenantsList() {
  const [tenants, setTenants] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    tenantsApi
      .list()
      .then(setTenants)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Tenants & KYC</h1>
          <p>
            Operators register themselves from the checkout app's Operator portal. Review their
            KYC documents here and activate Eganow credentials once approved.
          </p>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="panel">
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : tenants.length === 0 ? (
          <div className="empty-state">No tenants have registered yet.</div>
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th>Company</th>
                <th>Contact</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td>{t.companyName}</td>
                  <td className="mono">{t.contactEmail}</td>
                  <td><StatusChip status={t.status} /></td>
                  <td>
                    <Link to={`/tenants/${t.id}`} className="btn btn-secondary btn-sm">
                      Review
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
