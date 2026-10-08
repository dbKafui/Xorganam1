import { api } from './client'

export const authApi = {
  login: (email, password) => api.post('/auth/login', { email, password }),
  setupMfa: (challengeToken) => api.post('/auth/mfa/setup', { challengeToken }),
  verifyMfa: (challengeToken, code) => api.post('/auth/mfa/verify', { challengeToken, code }),
  logout: () => api.post('/auth/logout'),
  requestPasswordReset: (email) => api.post('/auth/password-reset/request', { email }),
  confirmPasswordReset: (token, newPassword) => api.post('/auth/password-reset/confirm', { token, newPassword }),
  me: () => api.get('/auth/me')
}

export const platformSecurityApi = {
  getMfaExemptions: () => api.get('/platform/security-settings/mfa-exemptions'),
  updateMfaExemption: (account, exempt) => api.put(
    `/platform/security-settings/mfa-exemptions/${account.type}/${account.id}`,
    { exempt }
  )
}
