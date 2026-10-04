import { NavLink, Outlet } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useOperatorAuth } from '../context/OperatorAuthContext'
import { operatorApi } from '../api/client'

export default function OperatorLayout() {
  const { logout, user } = useOperatorAuth()
  const [notifications, setNotifications] = useState([])

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
        </nav></>}
        <div className="portal-sidebar-bottom"><span className="portal-secure"><span /> Secure vendor workspace</span><button className="logout-link" onClick={logout}>↪ <span>Log out</span></button></div>
      </aside>
      <main className="portal-main">
        <header className="portal-topbar"><span>Business workspace <b>/</b> <strong>{user?.tenantCompanyName || user?.companyName || 'Vendor dashboard'}</strong></span><span className="portal-topbar-status"><i /> Account workspace</span></header>
      <div className="portal-body">
        {notifications.some((item) => !item.read_at) && <section aria-label="Unread notifications" style={{ margin: '0 0 16px', padding: 16, background: '#fff8e8', border: '1px solid #f0d99b', borderRadius: 8 }}>
          <strong>Notifications</strong>
          {notifications.filter((item) => !item.read_at).slice(0, 5).map((item) => <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 10 }}>
            <span><strong>{item.title}</strong><br />{item.body}</span>
            <button type="button" onClick={() => markRead(item.id)}>Mark read</button>
          </div>)}
        </section>}
        <Outlet />
      </div>
      </main>
    </div>
  )
}
