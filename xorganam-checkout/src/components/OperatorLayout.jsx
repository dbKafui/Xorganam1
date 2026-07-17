import { NavLink, Outlet } from 'react-router-dom'
import { useOperatorAuth } from '../context/OperatorAuthContext'

export default function OperatorLayout() {
  const { logout } = useOperatorAuth()

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
        <NavLink to="/operator/reports" className={({ isActive }) => (isActive ? 'active' : '')}>
          Reports
        </NavLink>
        <NavLink to="/operator/team" className={({ isActive }) => (isActive ? 'active' : '')}>
          Team
        </NavLink>
        <NavLink to="/operator/account" className={({ isActive }) => (isActive ? 'active' : '')}>
          Account & KYC
        </NavLink>
        <div className="spacer" />
        <button className="logout-link" onClick={logout} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>
          Log out
        </button>
      </nav>
      <div className="portal-body">
        <Outlet />
      </div>
    </div>
  )
}
