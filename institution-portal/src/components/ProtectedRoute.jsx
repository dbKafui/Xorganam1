import { Navigate } from 'react-router-dom'
import { useInstitutionAuth } from '../context/InstitutionAuthContext.jsx'

export default function ProtectedRoute({ children }) {
  const { staff, ready } = useInstitutionAuth()
  if (!ready) return <div className="boot-screen">Loading secure session...</div>
  if (!staff) return <Navigate to="/login" replace />
  return children
}
