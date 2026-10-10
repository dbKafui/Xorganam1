import { withTransaction } from '../db/pool.js'
import { writePlatformAudit } from './auditService.js'

export async function assignUserMerchant({ userId, tenantId, merchantId, actor, request }) {
  return withTransaction(async (client) => {
    const { rows: users } = await client.query(
      'SELECT tenant_id, merchant_id FROM users WHERE id = $1 FOR UPDATE', [userId]
    )
    const user = users[0]
    if (!user) return { userMissing: true }
    if (user.tenant_id !== tenantId) return { tenantMismatch: true }
    const { rows: merchants } = await client.query(
      'SELECT tenant_id FROM merchants WHERE id = $1 FOR SHARE', [merchantId]
    )
    if (!merchants.length) return { merchantMissing: true }
    if (merchants[0].tenant_id !== tenantId) return { merchantMismatch: true }
    if (user.merchant_id === merchantId) return { unchanged: true }
    const { rows } = await client.query(
      `UPDATE users SET merchant_id = $2, token_version = token_version + 1, updated_at = now() WHERE id = $1
       RETURNING id, tenant_id, merchant_id, first_name, last_name, email, phone_number, role, is_active, token_version, created_at, last_login_at`,
      [userId, merchantId]
    )
    await writePlatformAudit({
      actorUserId: actor.id,
      tenantId,
      merchantId,
      action: 'USER_MERCHANT_ASSIGNMENT_CHANGED',
      resourceType: 'user',
      resourceId: userId,
      details: { previousMerchantId: user.merchant_id, merchantId },
      ipAddress: request.ip || null,
      userAgent: request.headers['user-agent'] || null,
      requestId: request.id || null,
      client
    })
    return { user: rows[0] }
  })
}

export async function unassignUserMerchant({ userId, tenantId, actor, request }) {
  return withTransaction(async (client) => {
    const { rows: users } = await client.query(
      'SELECT tenant_id, merchant_id, role FROM users WHERE id = $1 FOR UPDATE', [userId]
    )
    const user = users[0]
    if (!user) return { userMissing: true }
    if (user.tenant_id !== tenantId) return { tenantMismatch: true }
    if (user.role === 'TENANT_BRANCH_MANAGER') return { branchManagerConflict: true }
    if (!user.merchant_id) return { unchanged: true }
    const { rows } = await client.query(
      `UPDATE users SET merchant_id = NULL, token_version = token_version + 1, updated_at = now() WHERE id = $1
       RETURNING id, tenant_id, merchant_id, first_name, last_name, email, phone_number, role, is_active, token_version, created_at, last_login_at`,
      [userId]
    )
    await writePlatformAudit({
      actorUserId: actor.id,
      tenantId,
      merchantId: user.merchant_id,
      action: 'USER_MERCHANT_ASSIGNMENT_CHANGED',
      resourceType: 'user',
      resourceId: userId,
      details: { previousMerchantId: user.merchant_id, merchantId: null },
      ipAddress: request.ip || null,
      userAgent: request.headers['user-agent'] || null,
      requestId: request.id || null,
      client
    })
    return { user: rows[0] }
  })
}
