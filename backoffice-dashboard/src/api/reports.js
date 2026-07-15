import { api } from './client'

export const reportsApi = {
  system: () => api.get('/reports/system'),
  tenant: (tenantId) => api.get('/reports/tenant', { tenantId }),
  merchant: (merchantId) => api.get('/reports/merchant', { merchantId })
}
