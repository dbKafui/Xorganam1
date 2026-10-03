import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useEffect } from 'react'
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
import OperatorReports from './pages/operator/OperatorReports'
import OperatorTeam from './pages/operator/OperatorTeam'
import OperatorAccount from './pages/operator/OperatorAccount'
import OperatorInstitutions from './pages/operator/OperatorInstitutions'
import OperatorCreditPlans from './pages/operator/OperatorCreditPlans'
import OperatorSettlements from './pages/operator/OperatorSettlements'
import HostedInstallmentPayment from './pages/HostedInstallmentPayment'
import CreditCustomerPlans from './pages/CreditCustomerPlans'
import Storefront from './pages/Storefront'
import Marketplace from './pages/Marketplace'
import CustomerOrders from './pages/CustomerOrders'
import OperatorStorefront from './pages/operator/OperatorStorefront'

export default function App() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('ref')) sessionStorage.setItem('xorganam_referral_code', params.get('ref'))
    if (params.get('institution')) sessionStorage.setItem('xorganam_referral_institution', params.get('institution'))
  }, [])
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <OperatorAuthProvider>
        <Routes>
          <Route path="/" element={<Checkout />} />
          <Route path="/marketplace" element={<Marketplace />} />
          <Route path="/store/:slug" element={<Storefront />} />
          <Route path="/my-orders" element={<CustomerOrders />} />
          <Route path="/pay/:installmentToken" element={<HostedInstallmentPayment />} />
          <Route path="/credit-schedule" element={<CreditCustomerPlans />} />
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
            <Route path="reports" element={<OperatorReports />} />
            <Route path="team" element={<OperatorTeam />} />
            <Route path="account" element={<OperatorAccount />} />
            <Route path="institutions" element={<OperatorInstitutions />} />
            <Route path="credit-plans" element={<OperatorCreditPlans />} />
            <Route path="settlements" element={<OperatorSettlements />} />
            <Route path="storefront" element={<OperatorStorefront />} />
          </Route>
        </Routes>
      </OperatorAuthProvider>
    </BrowserRouter>
  )
}
