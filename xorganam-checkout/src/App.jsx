import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { OperatorAuthProvider } from './context/OperatorAuthContext'
import ProtectedOperatorRoute from './components/ProtectedOperatorRoute'
import OperatorLayout from './components/OperatorLayout'

import Checkout from './pages/Checkout'
import OperatorRegister from './pages/operator/OperatorRegister'
import OperatorLogin from './pages/operator/OperatorLogin'
import OperatorOverview from './pages/operator/OperatorOverview'
import OperatorMerchants from './pages/operator/OperatorMerchants'
import OperatorMerchantForm from './pages/operator/OperatorMerchantForm'
import OperatorMerchantDetail from './pages/operator/OperatorMerchantDetail'
import OperatorTransactions from './pages/operator/OperatorTransactions'
import OperatorTransactionDetail from './pages/operator/OperatorTransactionDetail'
import OperatorInitiateCollection from './pages/operator/OperatorInitiateCollection'
import OperatorTeam from './pages/operator/OperatorTeam'
import OperatorAccount from './pages/operator/OperatorAccount'

export default function App() {
  return (
    <BrowserRouter>
      <OperatorAuthProvider>
        <Routes>
          <Route path="/" element={<Checkout />} />
          <Route path="/operator/register" element={<OperatorRegister />} />
          <Route path="/operator/login" element={<OperatorLogin />} />

          <Route
            path="/operator"
            element={
              <ProtectedOperatorRoute>
                <OperatorLayout />
              </ProtectedOperatorRoute>
            }
          >
            <Route path="dashboard" element={<OperatorOverview />} />
            <Route path="merchants" element={<OperatorMerchants />} />
            <Route path="merchants/new" element={<OperatorMerchantForm />} />
            <Route path="merchants/:merchantId" element={<OperatorMerchantDetail />} />
            <Route path="transactions" element={<OperatorTransactions />} />
            <Route path="transactions/new" element={<OperatorInitiateCollection />} />
            <Route path="transactions/:transactionId" element={<OperatorTransactionDetail />} />
            <Route path="team" element={<OperatorTeam />} />
            <Route path="account" element={<OperatorAccount />} />
          </Route>
        </Routes>
      </OperatorAuthProvider>
    </BrowserRouter>
  )
}
