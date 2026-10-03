import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import ProtectedRoute from './components/ProtectedRoute.jsx'
import PortalLayout from './components/PortalLayout.jsx'
import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Verification from './pages/Verification.jsx'
import Assignments from './pages/Assignments.jsx'
import Staff from './pages/Staff.jsx'
import Reconciliation from './pages/Reconciliation.jsx'
import Disputes from './pages/Disputes.jsx'
import AdapterSettings from './pages/AdapterSettings.jsx'
import TeamStructure from './pages/TeamStructure.jsx'
import InstitutionProfile from './pages/InstitutionProfile.jsx'
import InstitutionRegistration from './pages/InstitutionRegistration.jsx'

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<InstitutionRegistration />} />
        <Route path="/" element={<ProtectedRoute><PortalLayout /></ProtectedRoute>}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="verification" element={<Verification />} />
          <Route path="assignments" element={<Assignments />} />
          <Route path="team-structure" element={<TeamStructure />} />
          <Route path="profile" element={<InstitutionProfile />} />
          <Route path="staff" element={<Staff />} />
          <Route path="reconciliation" element={<Reconciliation />} />
          <Route path="disputes" element={<Disputes />} />
          <Route path="settings" element={<AdapterSettings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
