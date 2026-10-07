import { api } from './client'

export const authApi = {
  login: (email, password) => api.post('/auth/login', { email, password }),
  setupMfa: (challengeToken) => api.post('/auth/mfa/setup', { challengeToken }),
  verifyMfa: (challengeToken, code) => api.post('/auth/mfa/verify', { challengeToken, code }),
  me: () => api.get('/auth/me')
}

export const platformSecurityApi = {
  getMfaExemptions: () => api.get('/platform/security-settings/mfa-exemptions'),
  updateMfaExemption: (account, exempt) => api.put(
    `/platform/security-settings/mfa-exemptions/${account.type}/${account.id}`,
    { exempt }
  )
}
