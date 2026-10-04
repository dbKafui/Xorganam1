const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api/v1'
const TOKEN_KEY = 'xorganam_operator_token'
const USER_KEY = 'xorganam_operator_user'
const CREDIT_CUSTOMER_TOKEN_KEY = 'xorganam_credit_customer_token'
const CREDIT_CUSTOMER_PHONE_KEY = 'xorganam_credit_customer_phone'

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

function getToken() {
  const legacyToken = localStorage.getItem(TOKEN_KEY)
  if (legacyToken) {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  }
  return sessionStorage.getItem(TOKEN_KEY)
}

async function request(path, { method = 'GET', body, params, auth = false, isForm = false, token: explicitToken } = {}) {
  let url = `${BASE_URL}${path}`

  if (params) {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString()
    if (query) url += `?${query}`
  }

  const headers = {}
  if (auth) {
    const token = explicitToken || getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
  }
  if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(url, {
    method,
    headers,
    body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined
  })

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json') ? await response.json().catch(() => null) : null

  if (!response.ok) {
    throw new ApiError(payload?.message || `Request failed (${response.status}).`, response.status, payload?.errors)
  }

  return payload
}

// =====================================================================
// Anonymous customer checkout - scoped to a single merchant (market
// woman), never a tenant.
// =====================================================================
export const publicApi = {
  getMerchant: (merchantId) => request(`/public/merchants/${merchantId}`),
  collect: (payload) => request('/public/collect', { method: 'POST', body: payload }),
  getStatus: (reference) => request(`/public/collect/${reference}/status`),
  getCreditInstallment: (token) => request(`/public/credit-installments/${encodeURIComponent(token)}`),
  payCreditInstallment: (token, payload) => request(`/public/credit-installments/${encodeURIComponent(token)}/collect`, { method: 'POST', body: payload }),
  requestCreditCustomerCode: (phoneNumber) => request('/public/credit-customer/request-code', { method: 'POST', body: { phoneNumber } }),
  verifyCreditCustomerCode: (phoneNumber, code) => request('/public/credit-customer/verify-code', { method: 'POST', body: { phoneNumber, code } }),
  getStorefront: (slug) => request(`/public/storefronts/${encodeURIComponent(slug)}`),
  getMarketplaceCategories: () => request('/public/marketplace/categories'),
  searchMarketplace: (params = {}) => request('/public/marketplace/products', { params }),
  getMarketplaceCategoryProducts: (categoryId, params = {}) => request(`/public/marketplace/categories/${encodeURIComponent(categoryId)}/products`, { params }),
  getProductReviews: (productId) => request(`/public/marketplace/products/${encodeURIComponent(productId)}/reviews`),
  createStorefrontOrder: (slug, payload) => request(`/public/storefronts/${encodeURIComponent(slug)}/orders`, { method: 'POST', body: payload }),
  createMarketplaceOrder: (slug, payload) => request(`/public/marketplace/storefronts/${encodeURIComponent(slug)}/orders`, { method: 'POST', body: payload })
}

export const creditCustomerApi = {
  hasSession: () => !!sessionStorage.getItem(CREDIT_CUSTOMER_TOKEN_KEY),
  getPhone: () => sessionStorage.getItem(CREDIT_CUSTOMER_PHONE_KEY) || '',
  saveSession: ({ token, phoneNumber }) => {
    sessionStorage.setItem(CREDIT_CUSTOMER_TOKEN_KEY, token)
    sessionStorage.setItem(CREDIT_CUSTOMER_PHONE_KEY, phoneNumber)
  },
  clearSession: () => {
    sessionStorage.removeItem(CREDIT_CUSTOMER_TOKEN_KEY)
    sessionStorage.removeItem(CREDIT_CUSTOMER_PHONE_KEY)
  },
  listPlans: () => request('/credit-customer/plans', { auth: true, token: sessionStorage.getItem(CREDIT_CUSTOMER_TOKEN_KEY) }),
  payInstallment: (planId, installmentId) => request(`/credit-customer/plans/${encodeURIComponent(planId)}/installments/${encodeURIComponent(installmentId)}/collect`, { method: 'POST', auth: true, token: sessionStorage.getItem(CREDIT_CUSTOMER_TOKEN_KEY) })
}

export const storefrontCustomerApi = {
  listOrders: () => request('/storefront-customer/orders', { auth: true, token: sessionStorage.getItem(CREDIT_CUSTOMER_TOKEN_KEY) }),
  submitReview: (payload) => request('/storefront-customer/reviews', { method: 'POST', body: payload, auth: true, token: sessionStorage.getItem(CREDIT_CUSTOMER_TOKEN_KEY) })
}

// =====================================================================
// Operator (Tenant) auth - the business holding Eganow credentials,
// managing many merchants underneath it.
// =====================================================================
export const operatorAuth = {
  register: (payload) => request('/public/tenants/register', { method: 'POST', body: payload }),
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  setupMfa: (challengeToken) => request('/auth/mfa/setup', { method: 'POST', body: { challengeToken } }),
  verifyMfa: (challengeToken, code) => request('/auth/mfa/verify', { method: 'POST', body: { challengeToken, code } }),
  me: () => request('/auth/me', { auth: true }),
  saveSession: (result) => {
    sessionStorage.setItem(TOKEN_KEY, result.token)
    sessionStorage.setItem(USER_KEY, JSON.stringify(result.user))
  },
  clearSession: () => {
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(USER_KEY)
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  },
  getStoredUser: () => {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    const stored = sessionStorage.getItem(USER_KEY)
    return stored ? JSON.parse(stored) : null
  },
  hasToken: () => !!getToken()
}

// =====================================================================
// Operator portal - everything a Tenant's staff can do once logged in.
// =====================================================================
export const operatorApi = {
  listInstitutionFinanceProducts: (tenantId) => request('/tenant-portal/institution-finance/products', { params: { tenantId }, auth: true }),
  listInstitutionFinanceCustomers: (tenantId) => request('/tenant-portal/institution-finance/customers', { params: { tenantId }, auth: true }),
  listInstitutionFinanceAccounts: (tenantId) => request('/tenant-portal/institution-finance/accounts', { params: { tenantId }, auth: true }),
  requestInstitutionFinanceAccount: (payload) => request('/tenant-portal/institution-finance/accounts', { method: 'POST', body: payload, auth: true }),
  listInstitutionFinanceFees: (tenantId) => request('/tenant-portal/institution-finance/fees', { params: { tenantId }, auth: true }),
  listInstitutionFinanceTransactions: (tenantId) => request('/tenant-portal/institution-finance/transactions', { params: { tenantId }, auth: true }),
  createInstitutionFinanceTransaction: (payload) => request('/tenant-portal/institution-finance/transactions', { method: 'POST', body: payload, auth: true }),
  // Periodic sweeps are queued work; the reconciliation view shows their
  // persisted ledger rows so operators can distinguish pending and failed legs.
  runPeriodicSettlements: (tenantId) => request('/periodic-settlements/run-due', { method: 'POST', body: { tenantId }, auth: true }),
  getPeriodicSettlementReconciliation: (tenantId) => request('/periodic-settlements/reconciliation', { params: { tenantId }, auth: true }),
  // Tenant self / KYC
  getTenant: (tenantId) => request(`/tenants/${tenantId}`, { auth: true }),
  submitKycDocument: (tenantId, formData) =>
    request(`/tenants/${tenantId}/kyc-documents`, { method: 'POST', body: formData, isForm: true, auth: true }),

  // Reports
  tenantReport: (tenantId) => request('/reports/tenant', { params: { tenantId }, auth: true }),
  merchantReport: (merchantId) => request('/reports/merchant', { params: { merchantId }, auth: true }),
  getInstitutionSettlementOptions: (tenantId) =>
    request('/settlement-config/options', { params: { tenantId }, auth: true }),
  saveInstitutionSettlementConfig: (merchantId, institutionId, payload) =>
    request(`/settlement-config/merchants/${merchantId}/${institutionId}`, { method: 'PUT', body: payload, auth: true }),
  listInstitutions: () => request('/tenant-institution-links/institutions', { auth: true }),
  listTenantInstitutionLinks: (tenantId) => request('/tenant-institution-links', { params: { tenantId }, auth: true }),
  createTenantInstitutionLink: (payload) => request('/tenant-institution-links', { method: 'POST', body: payload, auth: true }),
  deactivateTenantInstitutionLink: (linkId, tenantId) => request(`/tenant-institution-links/${linkId}`, { method: 'DELETE', params: { tenantId }, auth: true }),
  listNotifications: () => request('/notifications', { auth: true }),
  markNotificationRead: (notificationId) => request(`/notifications/${notificationId}/read`, { method: 'PATCH', auth: true }),
  getSplitRules: (params) => request('/tenant-portal/split-rules', { params, auth: true }),
  saveDefaultSplitRule: (payload) => request('/tenant-portal/split-rules/default', { method: 'PUT', body: payload, auth: true }),
  saveSplitRule: (merchantId, payload) => request(`/tenant-portal/split-rules/${merchantId}`, { method: 'PUT', body: payload, auth: true }),
  createCreditPlan: (payload) => request('/credit-plans', { method: 'POST', body: payload, auth: true }),
  listCreditPlans: (params) => request('/credit-plans', { params, auth: true }),
  getCreditPlan: (planId) => request(`/credit-plans/${encodeURIComponent(planId)}`, { auth: true }),
  recordCreditCashPayment: (planId, installmentId) => request(`/credit-plans/${encodeURIComponent(planId)}/installments/${encodeURIComponent(installmentId)}/manual-payment`, { method: 'POST', auth: true }),
  createCreditPaymentLink: (planId, installmentId) => request(`/credit-plans/${encodeURIComponent(planId)}/installments/${encodeURIComponent(installmentId)}/payment-link`, { method: 'POST', auth: true }),
  getCreditExposure: (params) => request('/credit-plans/exposure', { params, auth: true }),
  getCreditWebhook: (merchantId, tenantId) => request(`/credit-webhooks/${encodeURIComponent(merchantId)}`, { params: { tenantId }, auth: true }),
  saveCreditWebhook: (merchantId, payload) => request(`/credit-webhooks/${encodeURIComponent(merchantId)}`, { method: 'PUT', body: payload, auth: true }),
  disableCreditWebhook: (merchantId, tenantId) => request(`/credit-webhooks/${encodeURIComponent(merchantId)}`, { method: 'DELETE', params: { tenantId }, auth: true }),

  getStorefront: (tenantId) => request('/storefront', { params: { tenantId }, auth: true }),
  saveStorefront: (payload) => request('/storefront', { method: 'PUT', body: payload, auth: true }),
  listStorefrontProducts: (tenantId) => request('/storefront/products', { params: { tenantId }, auth: true }),
  createStorefrontProduct: (payload) => request('/storefront/products', { method: 'POST', body: payload, auth: true }),
  updateStorefrontProduct: (productId, payload) => request(`/storefront/products/${encodeURIComponent(productId)}`, { method: 'PATCH', body: payload, auth: true }),
  deleteStorefrontProduct: (productId) => request(`/storefront/products/${encodeURIComponent(productId)}`, { method: 'DELETE', auth: true }),
  updateStorefrontProductVisibility: (productId, visible) => request(`/storefront/products/${encodeURIComponent(productId)}/visibility`, { method: 'PATCH', body: { visible }, auth: true }),
  updateStorefrontStock: (productId, payload) => request(`/storefront/products/${encodeURIComponent(productId)}/stock`, { method: 'PUT', body: payload, auth: true }),
  getStorefrontOrders: (params) => request('/storefront/orders', { params, auth: true }),
  updateStorefrontOrderStatus: (orderId, status, reason) => request(`/storefront/orders/${encodeURIComponent(orderId)}/status`, { method: 'PATCH', body: { status, reason }, auth: true }),
  getCreditDefaults: (tenantId) => request('/storefront/credit-defaults', { params: { tenantId }, auth: true }),
  saveCreditDefaults: (payload) => request('/storefront/credit-defaults', { method: 'PUT', body: payload, auth: true }),

  // Merchants (market women)
  listMerchants: (tenantId) => request('/merchants', { params: { tenantId }, auth: true }),
  createMerchant: (payload) => request('/merchants', { method: 'POST', body: payload, auth: true }),
  getMerchant: (merchantId) => request(`/merchants/${merchantId}`, { auth: true }),
  updateMerchant: (merchantId, payload) => request(`/merchants/${merchantId}`, { method: 'PUT', body: payload, auth: true }),
  updateMerchantSettings: (merchantId, payload) =>
    request(`/merchants/${merchantId}/settings`, { method: 'PUT', body: payload, auth: true }),

  // Transactions
  listTransactions: (params) => request('/transactions', { params: { ...params }, auth: true }),
  transactionDetail: (transactionId) => request(`/transactions/${transactionId}`, { auth: true }),
  raiseDispute: (payload) => request('/tenant-portal/disputes', { method: 'POST', body: payload, auth: true }),
  collect: (payload) => request('/transactions/collect', { method: 'POST', body: payload, auth: true }),
  collectForTenant: (tenantId, payload) => request(`/tenants/${tenantId}/collect`, { method: 'POST', body: payload, auth: true }),
  internalTransfer: (payload) => request('/transactions/internal-transfer', { method: 'POST', body: payload, auth: true }),
  payout: (payload) => request('/transactions/payout', { method: 'POST', body: payload, auth: true }),
  reconcile: (transactionId) => request(`/transactions/${transactionId}/reconcile`, { method: 'POST', auth: true }),

  // Team (tenant staff)
  listUsers: (tenantId, merchantId) => request('/users', { params: { tenantId, merchantId }, auth: true }),
  createUser: (payload) => request('/users', { method: 'POST', body: payload, auth: true }),
  updateUser: (userId, payload) => request(`/users/${userId}`, { method: 'PUT', body: payload, auth: true }),
  updateUserStatus: (userId, isActive) => request(`/users/${userId}/status`, { method: 'PUT', body: { isActive }, auth: true }),
  assignRole: (userId, role) => request(`/users/${userId}/assign-role`, { method: 'POST', body: { role }, auth: true }),
  assignMerchant: (userId, merchantId) => request(`/users/${userId}/assign-merchant`, { method: 'POST', body: { merchantId }, auth: true }),
  unassignMerchant: (userId) => request(`/users/${userId}/unassign-merchant`, { method: 'POST', auth: true }),
  listUserPermissions: (userId) => request(`/users/${userId}/permissions`, { auth: true }),
  grantPermission: (userId, payload) => request(`/users/${userId}/permissions`, { method: 'POST', body: payload, auth: true }),
  revokePermission: (userId, permissionId) => request(`/users/${userId}/permissions/${permissionId}`, { method: 'DELETE', auth: true })
}
