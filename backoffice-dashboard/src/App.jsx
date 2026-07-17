import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'

import Login from './pages/Login'
import Overview from './pages/Overview'
import TenantsList from './pages/Tenants/TenantsList'
import TenantDetail from './pages/Tenants/TenantDetail'
import Merchants from './pages/Merchants'
import TransactionsList from './pages/Transactions/TransactionsList'
import TransactionDetail from './pages/Transactions/TransactionDetail'
import Reports from './pages/Reports'

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
            <Route path="merchants" element={<Merchants />} />
            <Route path="transactions" element={<TransactionsList />} />
            <Route path="transactions/:transactionId" element={<TransactionDetail />} />
            <Route path="reports" element={<Reports />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
