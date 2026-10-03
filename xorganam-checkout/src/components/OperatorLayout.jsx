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
    <div className="portal">
      <nav className="portal-nav">
        <span className="brand-mark">XORGANAM</span>
        <NavLink to="/operator/dashboard" end className={({ isActive }) => (isActive ? 'active' : '')}>
          Overview
        </NavLink>
        <NavLink to="/operator/merchants" className={({ isActive }) => (isActive ? 'active' : '')}>
          Merchants
        </NavLink>
        <NavLink to="/operator/transactions" className={({ isActive }) => (isActive ? 'active' : '')}>
          Transactions
        </NavLink>
        {user?.role !== 'TENANT_BRANCH_MANAGER' && <NavLink to="/operator/reports" className={({ isActive }) => (isActive ? 'active' : '')}>
          Reports
        </NavLink>}
        {user?.role !== 'TENANT_BRANCH_MANAGER' && <NavLink to="/operator/team" className={({ isActive }) => (isActive ? 'active' : '')}>
          Team
        </NavLink>}
        {user?.role !== 'TENANT_BRANCH_MANAGER' && <NavLink to="/operator/account" className={({ isActive }) => (isActive ? 'active' : '')}>
          Account & KYC
        </NavLink>}
        <NavLink to="/operator/institutions" className={({ isActive }) => (isActive ? 'active' : '')}>
          Institution links
        </NavLink>
        <NavLink to="/operator/credit-plans" className={({ isActive }) => (isActive ? 'active' : '')}>
          Hire-purchase
        </NavLink>
        {['TENANT_ADMIN', 'TENANT_MANAGER'].includes(user?.role) && <NavLink to="/operator/settlements" className={({ isActive }) => (isActive ? 'active' : '')}>
          Periodic settlements
        </NavLink>}
        <NavLink to="/operator/storefront" className={({ isActive }) => (isActive ? 'active' : '')}>
          Storefront & orders
        </NavLink>
        <div className="spacer" />
        <button className="logout-link" onClick={logout} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>
          Log out
        </button>
      </nav>
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
    </div>
  )
}
