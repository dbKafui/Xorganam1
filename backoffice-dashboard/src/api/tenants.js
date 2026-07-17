import { api } from './client'

export const tenantsApi = {
  list: () => api.get('/tenants'),
  create: (payload) => api.post('/tenants', payload),
  detail: (tenantId) => api.get(`/tenants/${tenantId}`),
  update: (tenantId, payload) => api.put(`/tenants/${tenantId}`, payload),
  remove: (tenantId) => api.del(`/tenants/${tenantId}`),
  reviewKycDocument: (documentId, payload) => api.post(`/tenants/kyc-documents/${documentId}/review`, payload),
  getConfig: (tenantId) => api.get(`/tenants/${tenantId}/config`),
  updateEganowCredentials: (tenantId, payload) => api.put(`/tenants/${tenantId}/eganow-credentials`, payload),
  updateNotificationSettings: (tenantId, payload) => api.put(`/tenants/${tenantId}/notification-settings`, payload)
  ,
  collect: (tenantId, payload) => api.post(`/tenants/${tenantId}/collect`, payload)
}
