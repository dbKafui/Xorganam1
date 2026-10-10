import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { api } from '../api/client'

const NAV_ITEMS = [
  { to: '/', label: 'Overview' },
  { to: '/tenants', label: 'Tenants & KYC' },
  { to: '/merchants', label: 'Merchants' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/reports', label: 'Reports' },
  { to: '/storefront-operations', label: 'Storefront operations' },
  { to: '/institution-applications', label: 'Institution applications' },
  { to: '/security-settings', label: 'Security settings' },
  { to: '/audit-log', label: 'Activity audit log' }
]

export default function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [connectionStatus, setConnectionStatus] = useState('checking')
  const [checkingConnection, setCheckingConnection] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchError, setSearchError] = useState('')
  const [searchLoading, setSearchLoading] = useState(false)

  useEffect(() => {
    const term = searchTerm.trim()
    if (term.length < 2) {
      setSearchResults([])
      setSearchError('')
      setSearchLoading(false)
      return undefined
    }
    let active = true
    const timer = window.setTimeout(async () => {
      setSearchLoading(true)
      setSearchError('')
      try {
        const result = await api.get('/operations/search', { q: term })
        if (active) setSearchResults(result.results || [])
      } catch (error) {
        if (active) setSearchError(error.message)
      } finally {
        if (active) setSearchLoading(false)
      }
    }, 250)
    return () => { active = false; window.clearTimeout(timer) }
  }, [searchTerm])

  function openSearchResult(result) {
    const paths = {
      tenant: `/tenants/${result.id}`,
      merchant: `/merchants?merchantId=${encodeURIComponent(result.id)}`,
      transaction: `/transactions/${result.id}`,
      customer: `/transactions?tenantId=${encodeURIComponent(result.tenant_id)}&customerIdentifier=${encodeURIComponent(result.id)}`,
      user: `/security-settings?userId=${encodeURIComponent(result.id)}`
    }
    navigate(paths[result.entity_type] || '/')
    setSearchTerm('')
    setSearchResults([])
  }

  async function checkConnection() {
    if (!navigator.onLine) {
      setConnectionStatus('offline')
      return
    }
    setCheckingConnection(true)
    try {
      await api.readiness()
      setConnectionStatus('online')
    } catch {
      setConnectionStatus('degraded')
    } finally {
      setCheckingConnection(false)
    }
  }

  useEffect(() => {
    const online = () => checkConnection()
    const offline = () => setConnectionStatus('offline')
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    checkConnection()
    const timer = window.setInterval(checkConnection, 30000)
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
      window.clearInterval(timer)
    }
  }, [])

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          XORGANAM
          <small>Backoffice — platform admin</small>
        </div>

        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
          >
            {item.label}
          </NavLink>
        ))}

        <div className="sidebar-footer">
          <div>{user?.firstName} {user?.lastName}</div>
          <div>Platform Admin</div>
          <button onClick={logout}>Sign out</button>
        </div>
      </aside>

      <main className="content">
        <div className="global-search">
          <label htmlFor="global-search-input">Search merchants, transactions, customers, tenants, and users</label>
          <input id="global-search-input" type="search" autoComplete="off" value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && searchResults[0]) openSearchResult(searchResults[0]) }}
            placeholder="Enter at least 2 characters" aria-controls="global-search-results" />
          {searchTerm.trim().length >= 2 && <div className="global-search-results" id="global-search-results" role="region" aria-live="polite">
            {searchLoading ? <div className="global-search-message">Searching…</div>
              : searchError ? <div className="global-search-message" role="alert">{searchError}</div>
                : searchResults.length ? searchResults.map((result) => <button type="button" key={`${result.entity_type}-${result.id}`} onClick={() => openSearchResult(result)}>
                  <span>{result.label}</span><small>{result.entity_type.replace('_', ' ')}{result.status ? ` · ${result.status}` : ''}{result.description ? ` · ${result.description}` : ''}</small>
                </button>)
                  : <div className="global-search-message">No matching records.</div>}
          </div>}
        </div>
        {connectionStatus !== 'online' && <div className={`connection-banner ${connectionStatus}`} role="status" aria-live="polite">
          <span>{connectionStatus === 'offline' ? 'You are offline. Changes will not be submitted.' : connectionStatus === 'degraded' ? 'Backend services are unavailable. Do not repeat financial actions until their status is checked.' : 'Checking service connection…'}</span>
          <button type="button" onClick={checkConnection} disabled={checkingConnection}>
            {checkingConnection ? 'Checking…' : 'Retry connection'}
          </button>
        </div>}
        <Outlet />
      </main>
    </div>
  )
}
