import { z } from 'zod'

export function emailTenantScopeDecision(user, tenantId) {
  if (!z.string().uuid().safeParse(tenantId).success) return 'invalid'
  if (!user?.tenantId || String(user.tenantId) !== tenantId) return 'forbidden'
  return 'allowed'
}