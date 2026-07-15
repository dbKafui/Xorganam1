import { api } from './client'

export const merchantsApi = {
  list: (tenantId) => api.get('/merchants', { tenantId }),
  detail: (merchantId) => api.get(`/merchants/${merchantId}`)
}
