import { Router } from 'express'
import { query } from '../db/pool.js'
import { verifyPassword } from '../security/password.js'
import { signToken } from '../security/jwt.js'
import { authenticate } from '../middleware/auth.js'
import { isMfaRequired } from '../services/mfaPolicy.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { createSession, listSessionsForUser, revokeCurrentSession } from '../services/sessionService.js'
import { requestPasswordReset, resetPassword } from '../services/passwordResetService.js'
import { requestEmailVerification, verifyEmailAddress } from '../services/emailVerificationService.js'
import { auditRequest, writePlatformAudit } from '../services/auditService.js'

export const authRouter = Router()

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body || {}

  if (!email || !password) {
    await writePlatformAudit({
      action: 'LOGIN_FAILED',
      resourceType: 'user',
      details: { reason: 'missing_credentials' },
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      requestId: req.id || null
    })
    return res.status(400).json({ message: 'Email and password are required.' })
  }

  const { rows } = await query(
    `SELECT u.id, u.tenant_id, u.merchant_id, u.first_name, u.last_name, u.email, u.password_hash, u.role, u.is_active,
            u.mfa_enabled, u.token_version, u.password_reset_required, u.email_verified_at,
            t.company_name AS tenant_company_name
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.email = $1`,
    [String(email).toLowerCase().trim()]
  )

  if (rows.length === 0) {
    await writePlatformAudit({
      action: 'LOGIN_FAILED',
      resourceType: 'user',
      details: { reason: 'unknown_user' },
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      requestId: req.id || null
    })
    return res.status(401).json({ message: 'Invalid email or password.' })
  }

  const user = rows[0]

  if (!user.is_active) {
    await writePlatformAudit({
      action: 'LOGIN_FAILED',
      resourceType: 'user',
      resourceId: user.id,
      tenantId: user.tenant_id,
      details: { reason: 'deactivated_account' },
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      requestId: req.id || null
    })
    return res.status(401).json({ message: 'This account has been deactivated.' })
  }

  const valid = await verifyPassword(password, user.password_hash)
  if (!valid) {
    await writePlatformAudit({
      action: 'LOGIN_FAILED',
      resourceType: 'user',
      resourceId: user.id,
      tenantId: user.tenant_id,
      details: { reason: 'invalid_password' },
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      requestId: req.id || null
    })
    return res.status(401).json({ message: 'Invalid email or password.' })
  }

  if (user.password_reset_required) {
    await writePlatformAudit({
      actorUserId: user.id,
      tenantId: user.tenant_id,
      merchantId: user.merchant_id,
      action: 'LOGIN_BLOCKED_PASSWORD_RESET_REQUIRED',
      resourceType: 'user',
      resourceId: user.id,
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      requestId: req.id || null
    })
    return res.status(403).json({ message: 'A password reset is required before you can sign in.' })
  }

  if (!user.email_verified_at) {
    await writePlatformAudit({
      actorUserId: user.id,
      tenantId: user.tenant_id,
      merchantId: user.merchant_id,
      action: 'LOGIN_BLOCKED_EMAIL_UNVERIFIED',
      resourceType: 'user',
      resourceId: user.id,
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      requestId: req.id || null
    })
    return res.status(403).json({
      code: 'EMAIL_UNVERIFIED',
      message: 'Verify your email address before signing in.'
    })
  }

  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id])
  const mfaRequired = await isMfaRequired('TENANT', user.id)
  if (!mfaRequired) {
    const token = await createSession(user, req)
    await writePlatformAudit({
      actorUserId: user.id,
      tenantId: user.tenant_id,
      merchantId: user.merchant_id,
      action: 'LOGIN_SUCCEEDED',
      resourceType: 'user',
      resourceId: user.id,
      details: { mfaRequired: false },
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      requestId: req.id || null
    })
    return res.json({
      mfaRequired: false,
      token,
      user: mapUser(user)
    })
  }
  await writePlatformAudit({
    actorUserId: user.id,
    tenantId: user.tenant_id,
    merchantId: user.merchant_id,
    action: 'LOGIN_MFA_REQUIRED',
    resourceType: 'user',
    resourceId: user.id,
    details: { mfaEnrollmentRequired: !user.mfa_enabled },
    ipAddress: req.ip || null,
    userAgent: req.headers['user-agent'] || null,
    requestId: req.id || null
  })
  const challengeToken = signToken({ id: user.id, tenantId: user.tenant_id, role: user.role,
    mfaFlow: user.mfa_enabled ? 'CHALLENGE' : 'ENROLL', principalType: 'TENANT' })
  res.json({ mfaRequired: true, mfaEnrollmentRequired: !user.mfa_enabled, challengeToken, user: mapUser(user) })
})

authRouter.post('/logout', authenticate, asyncHandler(async (req, res) => {
  const revoked = await revokeCurrentSession(
    req.user.sessionId,
    req.user.id,
    'TENANT',
    req.user.id,
    'user_logout'
  )
  if (!revoked) return res.status(404).json({ message: 'Session no longer exists.' })
  res.status(204).send()
}))

authRouter.get('/sessions', authenticate, asyncHandler(async (req, res) => {
  const sessions = await listSessionsForUser(req.user.id)
  res.json({ sessions: sessions.map((session) => ({
    ...session,
    current: session.id === req.user.sessionId
  })) })
}))

authRouter.delete('/sessions/:sessionId', authenticate, asyncHandler(async (req, res) => {
  const revoked = await revokeCurrentSession(
    req.params.sessionId,
    req.user.id,
    'TENANT',
    req.user.id,
    'user_revoked_session'
  )
  if (!revoked) return res.status(404).json({ message: 'Active session not found.' })
  res.status(204).send()
}))

authRouter.post('/password-reset/request', asyncHandler(async (req, res) => {
  const result = await requestPasswordReset({ email: req.body?.email })
  await auditRequest(req, 'PASSWORD_RESET_REQUESTED', 'user', result.userId, {
    requested: result.requested,
    delivered: result.delivered,
    reason: result.reason || null
  })
  return res.status(202).json({ message: 'If the account exists, a reset link has been sent.' })
}))

authRouter.post('/email-verification/request', asyncHandler(async (req, res) => {
  const result = await requestEmailVerification(req.body?.email)
  await auditRequest(req, 'EMAIL_VERIFICATION_REQUESTED', 'user', null, {
    requested: result.requested,
    delivered: result.delivered,
    throttled: result.throttled || false
  })
  return res.status(202).json({ message: 'If the account requires verification, an email will be sent.' })
}))

authRouter.post('/email-verification/confirm', asyncHandler(async (req, res) => {
  const result = await verifyEmailAddress(req.body?.token)
  if (!result.verified) return res.status(400).json({ message: 'The verification link is invalid or has expired.' })
  return res.json({ message: 'Email verified. You can now sign in.' })
}))

authRouter.post('/password-reset/confirm', asyncHandler(async (req, res) => {
  const result = await resetPassword({ token: req.body?.token, newPassword: req.body?.newPassword })
  if (!result.reset) return res.status(400).json({ message: 'The reset link is invalid or has expired.' })
  return res.json({ message: 'Password updated successfully.' })
}))

authRouter.get('/me', authenticate, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.tenant_id, u.merchant_id, u.first_name, u.last_name, u.email, u.role, u.is_active,
            t.company_name AS tenant_company_name
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = $1`,
    [req.user.id]
  )

  if (rows.length === 0) return res.status(401).json({ message: 'Session no longer valid.' })

  const { rows: permissions } = await query(
    `SELECT permission_type, resource_id, expires_at FROM user_permissions WHERE user_id = $1`, [req.user.id]
  )

  res.json({
    ...mapUser(rows[0]),
    permissions: permissions.map((permission) => ({
      permissionType: permission.permission_type,
      resourceId: permission.resource_id,
      expiresAt: permission.expires_at
    }))
  })
}))

function mapUser(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    merchantId: row.merchant_id || null,
    tenantCompanyName: row.tenant_company_name || null,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    role: row.role,
    isPlatformAdmin: row.role === 'PLATFORM_ADMIN'
  }
}
