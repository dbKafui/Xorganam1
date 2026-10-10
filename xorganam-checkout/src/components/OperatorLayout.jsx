import { NavLink, Outlet } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useOperatorAuth } from '../context/OperatorAuthContext'
import { operatorApi } from '../api/client'

export default function OperatorLayout() {
  const { logout, user } = useOperatorAuth()
  const [notifications, setNotifications] = useState([])
  const [connectionStatus, setConnectionStatus] = useState('checking')
  const [checkingConnection, setCheckingConnection] = useState(false)

  async function checkConnection() {
    if (!navigator.onLine) {
      setConnectionStatus('offline')
      return
    }
    setCheckingConnection(true)
    try {
      await operatorApi.checkReadiness()
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

  useEffect(() => {
    let mounted = true
    const refresh = () => operatorApi.listNotifications().then((result) => {
      if (mounted) setNotifications(result?.notifications || [])
    }).catch(() => {})
    refresh()
    const timer = window.setInterval(refresh, 30000)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [])

  async function markRead(id) {
    await operatorApi.markNotificationRead(id)
    setNotifications((current) => current.map((item) => item.id === id ? { ...item, read_at: new Date().toISOString() } : item))
  }

  const unreadCount = notifications.filter((item) => !item.read_at).length

  return (
    <div className="portal portal-redesign">
      <aside className="portal-sidebar">
        <NavLink to="/operator/dashboard" className="portal-brand"><span className="portal-brand-icon">X</span><span>XORGANAM<small>VENDOR PORTAL</small></span></NavLink>
        <div className="portal-account"><span className="portal-avatar">{(user?.tenantCompanyName || user?.companyName || 'V').slice(0, 1).toUpperCase()}</span><span><strong>{user?.tenantCompanyName || user?.companyName || 'Business account'}</strong><small>{String(user?.role || 'Vendor').replaceAll('_', ' ').toLowerCase()}</small></span></div>
        <div className="portal-nav-caption">WORKSPACE</div>
        <nav className="portal-nav">
          <NavLink to="/operator/dashboard" end><span className="nav-glyph">⌂</span> Overview</NavLink>
          <NavLink to="/operator/merchants"><span className="nav-glyph">▦</span> Branches</NavLink>
          <NavLink to="/operator/transactions"><span className="nav-glyph">⇄</span> Transactions</NavLink>
          {user?.role !== 'TENANT_BRANCH_MANAGER' && <NavLink to="/operator/reports"><span className="nav-glyph">▥</span> Reports</NavLink>}
          {['TENANT_ADMIN', 'TENANT_MANAGER'].includes(user?.role) && <NavLink to="/operator/settlements"><span className="nav-glyph">◷</span> Settlements</NavLink>}
          <NavLink to="/operator/dashboard#notifications" className="notification-nav-link"><span className="nav-glyph">◌</span> Notifications {unreadCount > 0 && <span className="nav-badge" aria-label={`${unreadCount} unread notifications`}>{unreadCount}</span>}</NavLink>
        </nav>
        <div className="portal-nav-caption">GROW YOUR BUSINESS</div>
        <nav className="portal-nav">
          <NavLink to="/operator/institutions"><span className="nav-glyph">◇</span> Loans & savings</NavLink>
          <NavLink to="/operator/credit-plans"><span className="nav-glyph">▤</span> Hire-purchase</NavLink>
          <NavLink to="/operator/storefront"><span className="nav-glyph">▣</span> Storefront & orders</NavLink>
        </nav>
        {user?.role !== 'TENANT_BRANCH_MANAGER' && <><div className="portal-nav-caption">ADMINISTRATION</div><nav className="portal-nav">
          <NavLink to="/operator/team"><span className="nav-glyph">♧</span> Team access</NavLink>
          <NavLink to="/operator/account"><span className="nav-glyph">⚙</span> Account & KYC</NavLink>
          {['TENANT_ADMIN', 'TENANT_MANAGER'].includes(user?.role) && <NavLink to="/operator/email-settings"><span className="nav-glyph">✉</span> Email delivery</NavLink>}
        </nav></>}
        <div className="portal-sidebar-bottom"><span className="portal-secure"><span /> Secure vendor workspace</span><button className="logout-link" onClick={logout}>↪ <span>Log out</span></button></div>
      </aside>
      <main className="portal-main">
        <header className="portal-topbar"><span>Business workspace <b>/</b> <strong>{user?.tenantCompanyName || user?.companyName || 'Vendor dashboard'}</strong></span><span className="portal-topbar-status"><i /> Account workspace</span></header>
      <div className="portal-body">
        {connectionStatus !== 'online' && <div className={`connection-banner ${connectionStatus}`} role="status" aria-live="polite">
          <span>{connectionStatus === 'offline' ? 'You are offline. Changes will not be submitted.' : connectionStatus === 'degraded' ? 'Backend services are unavailable. Check payment status before retrying any financial action.' : 'Checking service connection…'}</span>
          <button type="button" onClick={checkConnection} disabled={checkingConnection}>
            {checkingConnection ? 'Checking…' : 'Retry connection'}
          </button>
        </div>}
        {notifications.some((item) => !item.read_at) && <section id="notifications" className="notification-banner" aria-label="Unread notifications">
          <div><strong>Notifications</strong><span>{unreadCount} unread update{unreadCount === 1 ? '' : 's'}</span></div>
          <div className="notification-list">
            {notifications.filter((item) => !item.read_at).slice(0, 5).map((item) => <div className="notification-item" key={item.id}>
              <span><strong>{item.title}</strong><small>{item.body}</small></span>
              <button type="button" onClick={() => markRead(item.id)}>Mark read</button>
            </div>)}
          </div>
        </section>}
        <Outlet />
      </div>
      </main>
    </div>
  )
}
