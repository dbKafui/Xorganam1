import { Navigate } from 'react-router-dom'
import { useOperatorAuth } from '../context/OperatorAuthContext'

export default function ProtectedOperatorRoute({ children }) {
  const { user, ready } = useOperatorAuth()

  if (!ready) return null
  if (!user) return <Navigate to="/operator/login" replace />

  return children
}
