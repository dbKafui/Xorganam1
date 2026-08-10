const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api/v1'
const TOKEN_KEY = 'xorganam_operator_token'
const USER_KEY = 'xorganam_operator_user'

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

async function request(path, { method = 'GET', body, params, auth = false, isForm = false } = {}) {
  let url = `${BASE_URL}${path}`

  if (params) {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString()
    if (query) url += `?${query}`
  }

  const headers = {}
  if (auth) {
    const token = getToken()
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
  getStatus: (reference) => request(`/public/collect/${reference}/status`)
}

// =====================================================================
// Operator (Tenant) auth - the business holding Eganow credentials,
// managing many merchants underneath it.
// =====================================================================
export const operatorAuth = {
  register: (payload) => request('/public/tenants/register', { method: 'POST', body: payload }),
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
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
  // Tenant self / KYC
  getTenant: (tenantId) => request(`/tenants/${tenantId}`, { auth: true }),
  submitKycDocument: (tenantId, formData) =>
    request(`/tenants/${tenantId}/kyc-documents`, { method: 'POST', body: formData, isForm: true, auth: true }),

  // Reports
  tenantReport: (tenantId) => request('/reports/tenant', { params: { tenantId }, auth: true }),
  merchantReport: (merchantId) => request('/reports/merchant', { params: { merchantId }, auth: true }),

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
