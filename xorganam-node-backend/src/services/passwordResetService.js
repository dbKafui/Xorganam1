import crypto from 'node:crypto'
import { query, withTransaction } from '../db/pool.js'
import { hashPassword } from '../security/password.js'
import { sendPasswordResetEmail, sendCredentialChangedEmail } from './notificationService.js'
import { authPolicy } from '../config/authPolicy.js'

const RESET_TOKEN_BYTES = 32
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function makeResetToken() {
  return crypto.randomBytes(RESET_TOKEN_BYTES).toString('base64url')
}

export function validateResetToken(token) {
  return typeof token === 'string' && RESET_TOKEN_PATTERN.test(token)
}

export async function requestPasswordReset({ email, purpose = 'reset' }) {
  const normalizedEmail = String(email || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return { requested: false, reason: 'invalid-email' }
  }

  const token = makeResetToken()
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const expiresAt = new Date(Date.now() + authPolicy.passwordResetTokenTtlMs).toISOString()
  const reservation = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, first_name, last_name, email
         FROM users WHERE email = $1 AND is_active = TRUE FOR UPDATE`,
      [normalizedEmail]
    )
    if (!rows.length) return { user: null }
    const user = rows[0]
    const { rows: recentRequests } = await client.query(
      `SELECT count(*)::int AS count FROM password_reset_tokens
        WHERE user_id = $1 AND created_at > now() - ($2::bigint * interval '1 millisecond')`,
      [user.id, authPolicy.passwordResetRateWindowMs]
    )
    if (recentRequests[0].count >= authPolicy.passwordResetRequestLimit) {
      return { user, throttled: true }
    }
    await client.query(
      `UPDATE password_reset_tokens SET used_at = now()
        WHERE user_id = $1 AND used_at IS NULL`,
      [user.id]
    )
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt]
    )
    return { user }
  })
  if (!reservation.user) return { requested: false, reason: 'unknown-user' }
  if (reservation.throttled) return { requested: false, throttled: true, userId: reservation.user.id }

  const resetUrl = new URL('/reset-password', process.env.APP_URL || 'http://localhost:5174')
  resetUrl.searchParams.set('token', token)
  const delivered = await sendPasswordResetEmail({
    email: reservation.user.email,
    firstName: reservation.user.first_name,
    lastName: reservation.user.last_name,
    resetUrl: resetUrl.toString(),
    purpose
  })

  if (!delivered) {
    await query('DELETE FROM password_reset_tokens WHERE token_hash = $1', [tokenHash])
    return {
      requested: true,
      delivered: false,
      tokenExpiresAt: expiresAt,
      userId: reservation.user.id
    }
  }

  return {
    requested: true,
    delivered: true,
    tokenExpiresAt: expiresAt,
    userId: reservation.user.id
  }
}

export async function resetPassword({ token, newPassword }) {
  if (!validateResetToken(token)) {
    return { reset: false, reason: 'invalid-or-expired-token' }
  }
  if (typeof newPassword !== 'string' || newPassword.length < 12) {
    throw new Error('Password must be at least 12 characters.')
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT pr.id, pr.user_id, pr.expires_at, pr.used_at, u.tenant_id, u.is_active,
              u.email, u.first_name
       FROM password_reset_tokens pr
       JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now()
      FOR UPDATE`,
      [tokenHash]
    )
    if (!rows.length || !rows[0].is_active) return { reset: false, reason: 'invalid-or-expired-token' }

    const userId = rows[0].user_id
    const passwordHash = await hashPassword(newPassword)
    await client.query(
      `UPDATE password_reset_tokens SET used_at = now()
        WHERE user_id = $1 AND used_at IS NULL`,
      [userId]
    )
    await client.query(
      `UPDATE users
       SET password_hash = $1,
           password_reset_required = FALSE,
           last_password_change_at = now(),
           token_version = token_version + 1
       WHERE id = $2`,
      [passwordHash, userId]
    )
    await client.query(
      `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    )
    await client.query(
      `INSERT INTO platform_audit_log
         (actor_user_id, tenant_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, 'PASSWORD_RESET_COMPLETED', 'user', $3, jsonb_build_object('tokenUsed', true, 'tokenId', $4))`,
      [userId, rows[0].tenant_id, userId, rows[0].id]
    )
    return { reset: true, userId, email: rows[0].email, firstName: rows[0].first_name }
  })
  if (result.reset) await sendCredentialChangedEmail({ email: result.email, firstName: result.firstName })
  return result.reset ? { reset: true, userId: result.userId } : result
}
