import crypto from 'node:crypto'
import { query, withTransaction } from '../db/pool.js'
import { hashPassword } from '../security/password.js'
import { sendPasswordResetEmail } from './notificationService.js'

const RESET_TOKEN_BYTES = 32
const RESET_TTL_MS = 30 * 60 * 1000
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function makeResetToken() {
  return crypto.randomBytes(RESET_TOKEN_BYTES).toString('base64url')
}

export function validateResetToken(token) {
  return typeof token === 'string' && RESET_TOKEN_PATTERN.test(token)
}

export async function requestPasswordReset({ email }) {
  const normalizedEmail = String(email || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return { requested: false, reason: 'invalid-email' }
  }

  const { rows } = await query(
    `SELECT id, first_name, last_name, email, token_version, password_reset_required
       FROM users
      WHERE email = $1 AND is_active = TRUE`,
    [normalizedEmail]
  )
  if (!rows.length) return { requested: false, reason: 'unknown-user' }

  const token = makeResetToken()
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString()
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [rows[0].id, tokenHash, expiresAt]
  )

  const delivered = await sendPasswordResetEmail({
    email: rows[0].email,
    firstName: rows[0].first_name,
    lastName: rows[0].last_name,
    resetUrl: `${process.env.APP_URL || ''}/reset-password?token=${encodeURIComponent(token)}`
  })

  if (!delivered) {
    await query('DELETE FROM password_reset_tokens WHERE token_hash = $1', [tokenHash])
    return {
      requested: true,
      delivered: false,
      tokenExpiresAt: expiresAt,
      userId: rows[0].id
    }
  }

  return {
    requested: true,
    delivered: true,
    tokenExpiresAt: expiresAt,
    userId: rows[0].id
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
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT pr.id, pr.user_id, pr.expires_at, pr.used_at, u.tenant_id, u.is_active
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
      `UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`,
      [rows[0].id]
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
       VALUES ($1, $2, 'PASSWORD_RESET_COMPLETED', 'user', $3, jsonb_build_object('tokenUsed', true, tokenId', $4))`,
      [userId, rows[0].tenant_id, userId, rows[0].id]
    )
    return { reset: true, userId }
  })
}
