const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api/v1'
const TOKEN_KEY = 'xorganam_institution_token'
const STAFF_KEY = 'xorganam_institution_staff'

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

async function request(path, { method = 'GET', body, auth = false } = {}) {
  const headers = {}
  if (auth) {
    const token = sessionStorage.getItem(TOKEN_KEY)
    if (token) headers.Authorization = `Bearer ${token}`
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json') ? await response.json() : null

  if (!response.ok) {
    throw new ApiError(payload?.message || `Request failed (${response.status}).`, response.status, payload)
  }
  return payload
}

export const institutionAuth = {
  login: (email, password) => request('/institution-auth/login', { method: 'POST', body: { email, password } }),
  setupMfa: (challengeToken) => request('/auth/mfa/setup', { method: 'POST', body: { challengeToken } }),
  verifyMfa: (challengeToken, code) => request('/auth/mfa/verify', { method: 'POST', body: { challengeToken, code } }),
  submitApplication: (body) => request('/institution-auth/registrations', { method: 'POST', body }),
  checkApplicationStatus: (applicationId, trackingToken) =>
    request(`/institution-auth/registrations/${encodeURIComponent(applicationId)}/status`, { method: 'POST', body: { trackingToken } }),
  me: () => request('/institution-auth/me', { auth: true }),
  saveSession: ({ token, staff }) => {
    sessionStorage.setItem(TOKEN_KEY, token)
    sessionStorage.setItem(STAFF_KEY, JSON.stringify(staff))
  },
  clearSession: () => {
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(STAFF_KEY)
  },
  hasToken: () => Boolean(sessionStorage.getItem(TOKEN_KEY)),
  getStoredStaff: () => {
    const value = sessionStorage.getItem(STAFF_KEY)
    return value ? JSON.parse(value) : null
  }
}

export const institutionApi = {
  getEganowProvisioning: () => request('/institution-portal/finance/eganow', { auth: true }),
  getApprovalPolicy: () => request('/institution-portal/finance/approval-policy', { auth: true }),
  saveApprovalPolicy: (supervisorApprovalLimitCents) => request('/institution-portal/finance/approval-policy', { method: 'PUT', body: { supervisorApprovalLimitCents }, auth: true }),
  saveEganowProvisioning: (payload) => request('/institution-portal/finance/eganow', { method: 'PUT', body: payload, auth: true }),
  testEganowProvisioning: () => request('/institution-portal/finance/eganow/test', { method: 'POST', body: {}, auth: true }),
  listFinanceCustomers: () => request('/institution-portal/finance/customers', { auth: true }),
  listFinanceLinkedTenants: () => request('/institution-portal/finance/linked-tenants', { auth: true }),
  listFinanceAvailableVendors: () => request('/institution-portal/finance/available-vendors', { auth: true }),
  listFinanceVendorLinks: () => request('/institution-portal/finance/vendor-links', { auth: true }),
  createFinanceVendorLink: (payload) => request('/institution-portal/finance/vendor-links', { method: 'POST', body: payload, auth: true }),
  createFinanceCustomer: (payload) => request('/institution-portal/finance/customers', { method: 'POST', body: payload, auth: true }),
  decideCustomerKyc: (customerId, payload) => request(`/institution-portal/finance/customers/${encodeURIComponent(customerId)}/kyc`, { method: 'PATCH', body: payload, auth: true }),
  updateCustomerNotificationConsent: (customerId, notificationConsent) => request(`/institution-portal/finance/customers/${encodeURIComponent(customerId)}/notification-consent`, { method: 'PATCH', body: { notificationConsent }, auth: true }),
  listFinanceProducts: () => request('/institution-portal/finance/products', { auth: true }),
  createFinanceProduct: (payload) => request('/institution-portal/finance/products', { method: 'POST', body: payload, auth: true }),
  updateFinanceProductPolicy: (productId, payload) => request(`/institution-portal/finance/products/${encodeURIComponent(productId)}/policy`, { method: 'PATCH', body: payload, auth: true }),
  updateFinanceProduct: (productId, status) => request(`/institution-portal/finance/products/${encodeURIComponent(productId)}`, { method: 'PATCH', body: { status }, auth: true }),
  listFinanceAccounts: () => request('/institution-portal/finance/accounts', { auth: true }),
  createFinanceAccount: (payload) => request('/institution-portal/finance/accounts', { method: 'POST', body: payload, auth: true }),
  decideFinanceAccount: (accountId, decision) => request(`/institution-portal/finance/accounts/${encodeURIComponent(accountId)}/decision`, { method: 'PATCH', body: { decision }, auth: true }),
  listFinanceTransactions: () => request('/institution-portal/finance/transactions', { auth: true }),
  createFinanceTransaction: (payload) => request('/institution-portal/finance/transactions', { method: 'POST', body: payload, auth: true }),
  decideFinanceTransaction: (transactionId, payload) => request(`/institution-portal/finance/transactions/${encodeURIComponent(transactionId)}/decision`, { method: 'PATCH', body: payload, auth: true }),
  reconcileFinanceTransaction: (transactionId) => request(`/institution-portal/finance/transactions/${encodeURIComponent(transactionId)}/reconcile`, { method: 'POST', body: {}, auth: true }),
  listFinanceFees: () => request('/institution-portal/finance/fees', { auth: true }),
  saveFinanceFees: (rules) => request('/institution-portal/finance/fees', { method: 'PUT', body: { rules }, auth: true }),
  listNotificationSettings: () => request('/institution-portal/notifications/settings', { auth: true }),
  saveNotificationSettings: (settings) => request('/institution-portal/notifications/settings', { method: 'PUT', body: { settings }, auth: true }),
  sendInstitutionNotification: (payload) => request('/institution-portal/notifications/send', { method: 'POST', body: payload, auth: true }),
  listNotificationLog: () => request('/institution-portal/notifications/log', { auth: true }),
  dashboard: () => request('/institution-portal/dashboard', { auth: true }),
  listLinks: () => request('/institution-portal/links', { auth: true }),
  verifyLink: (linkId, payload) =>
    request(`/institution-portal/links/${encodeURIComponent(linkId)}/verify`, { method: 'PATCH', body: payload, auth: true }),
  listLinkEvidence: (linkId) =>
    request(`/institution-portal/links/${encodeURIComponent(linkId)}/evidence`, { auth: true }),
  addLinkEvidence: (linkId, payload) =>
    request(`/institution-portal/links/${encodeURIComponent(linkId)}/evidence`, { method: 'POST', body: payload, auth: true }),
  listStaff: () => request('/institution-portal/staff', { auth: true }),
  createStaff: (payload) => request('/institution-portal/staff', { method: 'POST', body: payload, auth: true }),
  updateStaff: (staffId, payload) =>
    request(`/institution-portal/staff/${encodeURIComponent(staffId)}`, { method: 'PATCH', body: payload, auth: true }),
  generateReferralCode: (staffId) => request(`/institution-portal/staff/${encodeURIComponent(staffId)}/referral-code`, { method: 'PATCH', auth: true }),
  getInstitutionProfile: () => request('/institution-portal/profile', { auth: true }),
  updateInstitutionProfile: (payload) =>
    request('/institution-portal/profile', { method: 'PATCH', body: payload, auth: true }),
  listBranches: () => request('/institution-portal/branches', { auth: true }),
  createBranch: (payload) =>
    request('/institution-portal/branches', { method: 'POST', body: payload, auth: true }),
  updateBranch: (branchId, payload) =>
    request(`/institution-portal/branches/${encodeURIComponent(branchId)}`, { method: 'PATCH', body: payload, auth: true }),
  listHierarchy: () => request('/institution-portal/hierarchy', { auth: true }),
  saveHierarchy: (payload) =>
    request('/institution-portal/hierarchy', { method: 'POST', body: payload, auth: true }),
  listAssignments: () => request('/institution-portal/assignments', { auth: true }),
  createAssignment: (payload) => request('/institution-portal/assignments', { method: 'POST', body: payload, auth: true }),
  reconciliation: () => request('/institution-portal/reconciliation', { auth: true }),
  listDisputes: () => request('/institution-portal/disputes', { auth: true }),
  createDispute: (payload) => request('/institution-portal/disputes', { method: 'POST', body: payload, auth: true }),
  updateDispute: (disputeId, payload) =>
    request(`/institution-portal/disputes/${encodeURIComponent(disputeId)}`, { method: 'PATCH', body: payload, auth: true }),
  getAdapterConfig: () => request('/institution-portal/adapter-config', { auth: true }),
  saveAdapterConfig: (payload) => request('/institution-portal/adapter-config', { method: 'PUT', body: payload, auth: true })
}
