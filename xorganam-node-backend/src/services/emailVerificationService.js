import crypto from 'node:crypto'
import { query, withTransaction } from '../db/pool.js'
import { sendEmailVerificationEmail } from './notificationService.js'
import { authPolicy } from '../config/authPolicy.js'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function makeEmailVerificationToken() {
  return crypto.randomBytes(32).toString('base64url')
}

export function isValidEmailVerificationToken(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token)
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export async function requestEmailVerification(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase()
  if (!EMAIL_PATTERN.test(normalizedEmail) || normalizedEmail.length > 255) {
    return { requested: false, delivered: false }
  }

  const token = makeEmailVerificationToken()
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + authPolicy.emailVerificationTokenTtlMs).toISOString()
  const reservation = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, first_name, last_name, email, email_verified_at
         FROM users WHERE email = $1 AND is_active = TRUE FOR UPDATE`,
      [normalizedEmail]
    )
    const user = rows[0]
    if (!user || user.email_verified_at) return { send: false }

    const { rows: recent } = await client.query(
      `SELECT count(*)::int AS count FROM email_verification_tokens
        WHERE user_id = $1 AND created_at > now() - ($2::bigint * interval '1 millisecond')`,
      [user.id, authPolicy.emailVerificationRateWindowMs]
    )
    if (recent[0].count >= authPolicy.emailVerificationRequestLimit) return { send: false, throttled: true }

    await client.query(
      `UPDATE email_verification_tokens SET used_at = now()
        WHERE user_id = $1 AND used_at IS NULL`,
      [user.id]
    )
    await client.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt]
    )
    return { send: true, user }
  })

  if (!reservation.send) return { requested: false, delivered: false, throttled: reservation.throttled || false }
  const delivered = await sendEmailVerificationEmail({
    email: reservation.user.email,
    firstName: reservation.user.first_name,
    token
  })
  if (!delivered) {
    await query(
      `UPDATE email_verification_tokens SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL`,
      [tokenHash]
    )
  }
  return { requested: true, delivered }
}

export async function verifyEmailAddress(token) {
  if (!isValidEmailVerificationToken(token)) return { verified: false }
  const tokenHash = hashToken(token)
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT t.id, t.user_id, u.tenant_id
         FROM email_verification_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.used_at IS NULL
          AND t.expires_at > now() AND u.is_active = TRUE
        FOR UPDATE OF t, u`,
      [tokenHash]
    )
    if (!rows.length) return { verified: false }

    const verification = rows[0]
    await client.query(
      `UPDATE email_verification_tokens SET used_at = now()
        WHERE user_id = $1 AND used_at IS NULL`,
      [verification.user_id]
    )
    await client.query(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now())
        WHERE id = $1`,
      [verification.user_id]
    )
    await client.query(
      `INSERT INTO platform_audit_log (tenant_id, action, resource_type, resource_id, details)
       VALUES ($1, 'EMAIL_VERIFIED', 'user', $2, jsonb_build_object('verificationTokenUsed', true))`,
      [verification.tenant_id, verification.user_id]
    )
    return { verified: true }
  })
}
