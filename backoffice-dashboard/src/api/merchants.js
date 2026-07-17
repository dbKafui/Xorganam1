import { api } from './client'

export const merchantsApi = {
  list: (tenantId) => api.get('/merchants', { tenantId }),
  all: () => api.get('/merchants'),
  detail: (merchantId) => api.get(`/merchants/${merchantId}`),
  create: (payload) => api.post('/merchants', payload),
  update: (merchantId, payload) => api.put(`/merchants/${merchantId}`, payload),
  remove: (merchantId) => api.del(`/merchants/${merchantId}`)
}
