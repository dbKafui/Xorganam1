import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'

import Login from './pages/Login'
import Overview from './pages/Overview'
import TenantsList from './pages/Tenants/TenantsList'
import TenantDetail from './pages/Tenants/TenantDetail'
import TransactionsList from './pages/Transactions/TransactionsList'
import TransactionDetail from './pages/Transactions/TransactionDetail'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />

          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Overview />} />
            <Route path="tenants" element={<TenantsList />} />
            <Route path="tenants/:tenantId" element={<TenantDetail />} />
            <Route path="transactions" element={<TransactionsList />} />
            <Route path="transactions/:transactionId" element={<TransactionDetail />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
