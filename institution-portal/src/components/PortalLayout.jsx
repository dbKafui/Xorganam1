import { NavLink, Outlet } from 'react-router-dom'
import { useInstitutionAuth } from '../context/InstitutionAuthContext.jsx'

const NAV = [
  { to: '/dashboard', label: 'Overview', icon: '01' },
  { to: '/finance', label: 'Loans & savings', icon: '02' },
  { to: '/notifications', label: 'Notifications', icon: '03' },
  { to: '/verification', label: 'Verification queue', icon: '04' },
  { to: '/assignments', label: 'Assignments', icon: '05' },
  { to: '/team-structure', label: 'Team structure', icon: '06' },
  { to: '/staff', label: 'Staff', icon: '07' },
  { to: '/reconciliation', label: 'Reconciliation', icon: '08' },
  { to: '/disputes', label: 'Disputes', icon: '09' },
  { to: '/profile', label: 'Institution profile', icon: '10' },
  { to: '/settings', label: 'API adapter', icon: '11' }
]

export default function PortalLayout() {
  const { staff, logout } = useInstitutionAuth()
  const canSeeStaff = ['SUPERVISOR', 'INSTITUTION_ADMIN'].includes(staff?.role)
  const canManageSettings = staff?.role === 'INSTITUTION_ADMIN'
  const canManageTeam = canSeeStaff

  return (
    <div className="portal-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-symbol">X</span>
          <span>XORGANAM<small>INSTITUTION PORTAL</small></span>
        </div>
        <div className="institution-chip">
          <span className="institution-dot" />
          <span><small>Institution workspace</small><strong>{staff?.institutionName || (staff?.institutionId ? `Institution ${staff.institutionId.slice(0, 8)}` : 'Institution')}</strong></span>
        </div>
        <nav className="nav-list" aria-label="Portal navigation">
          {NAV.filter((item) =>
            (item.to !== '/staff' || canSeeStaff) &&
            (item.to !== '/assignments' || canSeeStaff) &&
            (item.to !== '/team-structure' || canManageTeam) &&
            (item.to !== '/settings' || canManageSettings)
          ).map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <span className="nav-index">{item.icon}</span>{item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="staff-profile">
            <div className="avatar">{staff?.firstName?.slice(0, 1)}{staff?.lastName?.slice(0, 1)}</div>
            <div className="staff-identity">
              <strong>{staff?.firstName} {staff?.lastName}</strong>
              <span>{String(staff?.role || '').replaceAll('_', ' ')}</span>
            </div>
          </div>
          <button className="signout" onClick={logout}>Sign out <span>↗</span></button>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div><span className="topbar-label">XORGANAM / INSTITUTION</span><span className="secure-state"><i /> Secure workspace</span></div>
          <div className="topbar-right"><span>{new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span><span className="topbar-divider" /><span>{staff?.email}</span></div>
        </header>
        <div className="page-content"><Outlet /></div>
      </main>
    </div>
  )
}
