import { withTransaction } from '../db/pool.js'
import { writePlatformAudit } from './auditService.js'

export async function requestUserRoleChange({ userId, tenantId, requestedRole, actor, request }) {
  return withTransaction(async (client) => {
    const { rows: userRows } = await client.query(
      'SELECT role, merchant_id FROM users WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [userId, tenantId]
    )
    const user = userRows[0]
    if (!user) return { notFound: true }
    if (user.role === requestedRole) return { unchanged: true }
    const { rows: pendingRows } = await client.query(
      `SELECT id FROM user_role_change_requests
        WHERE user_id = $1 AND status = 'PENDING' FOR UPDATE`,
      [userId]
    )
    if (pendingRows.length) return { pending: pendingRows[0].id }
    const { rows } = await client.query(
      `INSERT INTO user_role_change_requests
        (tenant_id, user_id, requested_by_user_id, previous_role, requested_role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, status, created_at`,
      [tenantId, userId, actor.id, user.role, requestedRole]
    )
    await writePlatformAudit({
      actorUserId: actor.id,
      tenantId,
      merchantId: user.merchant_id,
      action: 'USER_ROLE_CHANGE_REQUESTED',
      resourceType: 'user',
      resourceId: userId,
      details: { requestId: rows[0].id, previousRole: user.role, requestedRole },
      ipAddress: request.ip || null,
      userAgent: request.headers['user-agent'] || null,
      requestId: request.id || null,
      client
    })
    return { request: rows[0] }
  })
}

export async function reviewUserRoleChange({ requestId, tenantId, actor, decision, reason, request }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM user_role_change_requests
        WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [requestId, tenantId]
    )
    const roleRequest = rows[0]
    if (!roleRequest) return { notFound: true }
    if (roleRequest.status !== 'PENDING') return { conflict: 'This role-change request has already been reviewed.' }
    if (roleRequest.requested_by_user_id === actor.id) {
      await writePlatformAudit({
        actorUserId: actor.id,
        tenantId,
        action: 'USER_ROLE_CHANGE_SELF_REVIEW_BLOCKED',
        resourceType: 'user',
        resourceId: roleRequest.user_id,
        details: { requestId, requestedRole: roleRequest.requested_role },
        ipAddress: request.ip || null,
        userAgent: request.headers['user-agent'] || null,
        requestId: request.id || null,
        client
      })
      return { forbidden: true }
    }

    if (decision === 'APPROVED') {
      const { rows: userRows } = await client.query(
        'SELECT role, merchant_id FROM users WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [roleRequest.user_id, tenantId]
      )
      if (!userRows.length || userRows[0].role !== roleRequest.previous_role) {
        return { conflict: 'The user role changed after this request was created.' }
      }
      await client.query(
        'UPDATE users SET role = $2, token_version = token_version + 1, updated_at = now() WHERE id = $1',
        [roleRequest.user_id, roleRequest.requested_role]
      )
    }
    await client.query(
      `UPDATE user_role_change_requests
          SET status = $2, reviewed_by_user_id = $3, reviewed_at = now(), review_reason = $4
        WHERE id = $1`,
      [requestId, decision, actor.id, decision === 'REJECTED' ? reason : null]
    )
    await writePlatformAudit({
      actorUserId: actor.id,
      tenantId,
      action: decision === 'APPROVED' ? 'USER_ROLE_CHANGE_APPROVED' : 'USER_ROLE_CHANGE_REJECTED',
      resourceType: 'user',
      resourceId: roleRequest.user_id,
      details: {
        requestId,
        requestedByUserId: roleRequest.requested_by_user_id,
        reviewedByUserId: actor.id,
        previousRole: roleRequest.previous_role,
        requestedRole: roleRequest.requested_role,
        ...(decision === 'REJECTED' ? { reason } : {})
      },
      ipAddress: request.ip || null,
      userAgent: request.headers['user-agent'] || null,
      requestId: request.id || null,
      client
    })
    return { reviewed: true, userId: roleRequest.user_id, role: decision === 'APPROVED' ? roleRequest.requested_role : roleRequest.previous_role }
  })
}
