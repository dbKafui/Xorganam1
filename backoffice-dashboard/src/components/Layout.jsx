import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const NAV_ITEMS = [
  { to: '/', label: 'Overview' },
  { to: '/tenants', label: 'Tenants & KYC' },
  { to: '/merchants', label: 'Merchants' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/reports', label: 'Reports' }
]

export default function Layout() {
  const { user, logout } = useAuth()

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
        <Outlet />
      </main>
    </div>
  )
}
