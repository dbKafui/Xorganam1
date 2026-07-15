import { api } from './client'

export const tenantsApi = {
  list: () => api.get('/tenants'),
  detail: (tenantId) => api.get(`/tenants/${tenantId}`),
  reviewKycDocument: (documentId, payload) => api.post(`/tenants/kyc-documents/${documentId}/review`, payload),
  getConfig: (tenantId) => api.get(`/tenants/${tenantId}/config`),
  updateEganowCredentials: (tenantId, payload) => api.put(`/tenants/${tenantId}/eganow-credentials`, payload),
  updateNotificationSettings: (tenantId, payload) => api.put(`/tenants/${tenantId}/notification-settings`, payload)
}
