import { api } from './client'

export const transactionsApi = {
  list: (params) => api.get('/transactions', params),
  detail: (transactionId) => api.get(`/transactions/${transactionId}`),
  reconcile: (transactionId) => api.post(`/transactions/${transactionId}/reconcile`)
}
