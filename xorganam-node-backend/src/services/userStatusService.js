import { withTransaction } from '../db/pool.js'
import { writePlatformAudit } from './auditService.js'

export async function setTenantUserActiveStatus({ userId, isActive, reason, actor, request }) {
  if (typeof isActive !== 'boolean') throw new Error('User active status must be a boolean.')
  const normalizedReason = String(reason || '').trim()
  if (!isActive && (normalizedReason.length < 5 || normalizedReason.length > 1000)) {
    throw new Error('A deactivation reason between 5 and 1000 characters is required.')
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT tenant_id, merchant_id, is_active FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    )
    const user = rows[0]
    if (!user) return null
    if (user.is_active === isActive) return { isActive, unchanged: true }

    await client.query(
      `UPDATE users SET is_active = $2,
                        token_version = token_version + CASE WHEN $2 THEN 0 ELSE 1 END,
                        updated_at = now()
        WHERE id = $1`,
      [userId, isActive]
    )
    if (!isActive) {
      await client.query(
        `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      )
    }
    await writePlatformAudit({
      actorUserId: actor.id,
      tenantId: user.tenant_id,
      merchantId: user.merchant_id,
      action: isActive ? 'USER_REACTIVATED' : 'USER_DEACTIVATED',
      resourceType: 'user',
      resourceId: userId,
      details: {
        previousIsActive: user.is_active,
        isActive,
        ...(isActive ? {} : { reason: normalizedReason })
      },
      ipAddress: request.ip || null,
      userAgent: request.headers['user-agent'] || null,
      requestId: request.id || null,
      client
    })
    return { isActive, unchanged: false }
  })
}
