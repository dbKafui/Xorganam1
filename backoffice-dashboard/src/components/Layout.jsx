import { NavLink, Outlet } from 'react-router-dom'
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
  const [connectionStatus, setConnectionStatus] = useState('checking')
  const [checkingConnection, setCheckingConnection] = useState(false)

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
