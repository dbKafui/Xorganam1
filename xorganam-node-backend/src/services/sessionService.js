import { randomUUID } from 'node:crypto'
import { query, withTransaction } from '../db/pool.js'
import { signToken, verifyToken } from '../security/jwt.js'

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function sessionId() {
  return randomUUID()
}

export function validateSessionActor(actorUserId, actorInstitutionStaffId) {
  const userActor = actorUserId !== null && actorUserId !== undefined
  const institutionActor = actorInstitutionStaffId !== null && actorInstitutionStaffId !== undefined
  if (userActor && institutionActor) {
    throw new Error('Session revocation permits at most one actor.')
  }
  if (userActor && !UUID_PATTERN.test(String(actorUserId))) {
    throw new Error('Session revocation requires a valid user actor ID.')
  }
  if (institutionActor && !UUID_PATTERN.test(String(actorInstitutionStaffId))) {
    throw new Error('Session revocation requires a valid institution actor ID.')
  }
  return { userActor, institutionActor }
}

export function createSessionToken(user) {
  const sessionIdValue = sessionId()
  const token = signToken({
    id: user.id,
    tenantId: user.tenant_id || null,
    role: user.role,
    tokenVersion: user.token_version,
    sessionId: sessionIdValue,
    institutionId: user.institution_id || null,
    institutionStaffId: user.institution_staff_id || null,
    mfa: user.mfa === true
  })

  return {
    token,
    sessionId: sessionIdValue,
    expiresAt: new Date(Date.now() + SESSION_DURATION_MS).toISOString()
  }
}

export async function createSession(user, request) {
  const { token, sessionId: newSessionId, expiresAt } = createSessionToken(user)
  const payload = verifyToken(token)
  await query(
    `INSERT INTO sessions
       (id, user_id, institution_staff_id, tenant_id, token_version, expires_at,
        user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      newSessionId,
      user.id,
      user.institution_staff_id || null,
      user.tenant_id || null,
      payload.tokenVersion,
      expiresAt,
      request.headers['user-agent'] || null,
      request.ip || null
    ]
  )
  return token
}

export async function validateSessionToken(token) {
  const payload = verifyToken(token)
  if (!payload.sessionId || !payload.sub || payload.tokenVersion === undefined) {
    throw new Error('Session token is invalid.')
  }

  const principalCondition = payload.institutionStaffId
    ? 'institution_staff_id = $2'
    : 'user_id = $2'
  const { rows } = await query(
    `WITH touch_stale_session AS (
       UPDATE sessions SET last_seen_at = now()
        WHERE id = $1 AND ${principalCondition} AND token_version = $3
          AND revoked_at IS NULL AND expires_at > now()
          AND last_seen_at < now() - interval '5 minutes'
        RETURNING id
     )
     SELECT id, user_id, institution_staff_id, token_version, expires_at, revoked_at
       FROM sessions
      WHERE id = $1 AND ${principalCondition} AND token_version = $3
        AND revoked_at IS NULL AND expires_at > now()`,
    [payload.sessionId, payload.sub, payload.tokenVersion]
  )
  if (!rows.length) throw new Error('Session token is invalid or revoked.')
  return payload
}

export async function revokeSessionsForUser(userId, actorUserId, actorInstitutionStaffId, reason) {
  if (!reason || typeof reason !== 'string' || reason.length > 2000) {
    throw new Error('Session revocation reason is required and must be at most 2000 characters.')
  }
  validateSessionActor(actorUserId, actorInstitutionStaffId)

  await withTransaction(async (client) => {
    const now = new Date().toISOString()
    await client.query(
      `UPDATE sessions
         SET revoked_at = $2
       WHERE (user_id = $1 OR institution_staff_id = $1) AND revoked_at IS NULL`,
      [userId, now]
    )
    await client.query(
      `UPDATE users
         SET token_version = token_version + 1,
             password_reset_required = TRUE
       WHERE id = $1`,
      [userId]
    )
    await client.query(
      `INSERT INTO platform_audit_log
         (actor_user_id, actor_institution_staff_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, 'SESSION_REVOKED', 'user', $3, jsonb_build_object('reason', $4))`,
      [actorUserId, actorInstitutionStaffId, userId, reason]
    )
  })
}

export async function revokeCurrentSession(sessionId, principalId, principalType, actorUserId, reason) {
  if (!sessionId || !principalId || !principalType) {
    throw new Error('Session ID and principal are required.')
  }
  if (!['TENANT', 'INSTITUTION'].includes(principalType)) {
    throw new Error('Session principal type must be TENANT or INSTITUTION.')
  }
  if (!actorUserId || !reason || typeof reason !== 'string' || reason.length > 2000) {
    throw new Error('Session actor and revocation reason are required and must be valid.')
  }
  validateSessionActor(actorUserId, null)

  const principalColumn = principalType === 'INSTITUTION' ? 'institution_staff_id' : 'user_id'
  const actorColumn = principalType === 'INSTITUTION' ? 'actor_institution_staff_id' : 'actor_user_id'
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE sessions
         SET revoked_at = now()
       WHERE id = $1 AND ${principalColumn} = $2 AND revoked_at IS NULL`,
      [sessionId, principalId]
    )
    if (!rowCount) return false

    await client.query(
      `INSERT INTO platform_audit_log
         (${actorColumn}, action, resource_type, resource_id, details)
       VALUES ($1, 'SESSION_REVOKED', 'session', $2, jsonb_build_object('reason', $3))`,
      [actorUserId, sessionId, reason]
    )
    return true
  })
}

export async function revokeUserSessions(userId, actorUserId, actorInstitutionStaffId, reason) {
  return revokeSessionsForUser(userId, actorUserId, actorInstitutionStaffId, reason)
}

export async function invalidateSessionById(sessionId, actorUserId, reason) {
  if (!reason || typeof reason !== 'string' || reason.length > 2000) {
    throw new Error('Session revocation reason is required and must be at most 2000 characters.')
  }
  validateSessionActor(actorUserId, null)

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId]
    )
    await client.query(
      `INSERT INTO platform_audit_log
         (actor_user_id, action, resource_type, resource_id, details)
       VALUES ($1, 'SESSION_REVOKED', 'session', $2, jsonb_build_object('reason', $3))`,
      [actorUserId, sessionId, reason]
    )
  })
}

export async function listSessionsForUser(userId, principalType = 'TENANT') {
  if (!UUID_PATTERN.test(String(userId || '')) || !['TENANT', 'INSTITUTION'].includes(principalType)) {
    throw new Error('A valid session principal is required.')
  }
  const principalColumn = principalType === 'INSTITUTION' ? 'institution_staff_id' : 'user_id'
  const { rows } = await query(
    `SELECT id, token_version, created_at, last_seen_at, expires_at, revoked_at,
            user_agent, ip_address
     FROM sessions
     WHERE ${principalColumn} = $1 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC`,
    [userId]
  )
  return rows
}

export async function consumeResetToken(tokenHash, userId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, user_id, expires_at, used_at
       FROM password_reset_tokens
      WHERE token_hash = $1 AND user_id = $2 AND used_at IS NULL
        AND expires_at > now()
      FOR UPDATE`,
      [tokenHash, userId]
    )
    if (!rows.length) return null
    await client.query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`,
      [rows[0].id]
    )
    return rows[0]
  })
}
