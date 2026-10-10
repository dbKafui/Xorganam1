import { Router } from 'express'
import { query } from '../db/pool.js'
import { encrypt, decrypt } from '../security/encryption.js'
import { verifyToken } from '../security/jwt.js'
import { createTotpSecret, verifyTotp, totpProvisioningUri } from '../security/totp.js'
import { createSession } from '../services/sessionService.js'
import { authenticate } from '../middleware/auth.js'
import { institutionAuthenticate } from '../middleware/institutionAuth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { consumeMfaRecoveryCode, enableMfaWithRecoveryCodes, replaceMfaRecoveryCodes } from '../services/mfaRecoveryService.js'
import { setAdminSessionCookie } from '../security/adminSessionCookie.js'

export const mfaRouter = Router()
const ENCRYPTION_CONTEXT = 'xorganam-authenticator-mfa-v1'

function principalContext(principal) {
  return `${ENCRYPTION_CONTEXT}:${principal.kind}:${principal.id}`
}

async function rotateRecoveryCodes(principalId, principalType, code, req, res) {
  const principal = principalType === 'TENANT'
    ? await query('SELECT mfa_enabled, mfa_secret_encrypted FROM users WHERE id = $1', [principalId])
    : await query('SELECT mfa_enabled, mfa_secret_encrypted FROM institution_staff WHERE id = $1', [principalId])
  const row = principal.rows[0]
  if (!row?.mfa_enabled || !row.mfa_secret_encrypted) {
    return res.status(409).json({ message: 'Authenticator MFA is not enabled for this account.' })
  }
  const secret = await decrypt(row.mfa_secret_encrypted, principalContext({ kind: principalType, id: principalId }))
  if (!secret || secret === row.mfa_secret_encrypted || !verifyTotp(secret, code)) {
    return res.status(401).json({ message: 'A valid authenticator code is required to rotate recovery codes.' })
  }
  const recoveryCodes = await replaceMfaRecoveryCodes(principalId, principalType, undefined, {
    ipAddress: req.ip || null,
    userAgent: req.headers['user-agent'] || null,
    requestId: req.id || null
  })
  return res.json({ recoveryCodes })
}

function getChallenge(req) {
  const token = req.body?.challengeToken
  if (typeof token !== 'string') return null
  try {
    const payload = verifyToken(token)
    if (!['ENROLL', 'CHALLENGE'].includes(payload.mfaFlow) || !['TENANT', 'INSTITUTION'].includes(payload.principalType)) return null
    return payload
  } catch {
    return null
  }
}

mfaRouter.post('/recovery-codes/rotate', authenticate, asyncHandler(async (req, res) => {
  return rotateRecoveryCodes(req.user.id, 'TENANT', req.body?.code, req, res)
}))

mfaRouter.post('/recovery-codes/rotate-institution', institutionAuthenticate, asyncHandler(async (req, res) => {
  return rotateRecoveryCodes(req.institutionAuth.id, 'INSTITUTION', req.body?.code, req, res)
}))

async function loadPrincipal(challenge) {
  if (challenge.principalType === 'INSTITUTION') {
    const { rows } = await query(
      `SELECT s.id, s.institution_id, s.branch_id, i.name AS institution_name,
              s.email, s.first_name, s.last_name, s.role,
              s.is_active, s.mfa_enabled, s.mfa_secret_encrypted, s.mfa_pending_secret_encrypted,
              s.token_version, i.status AS institution_status
         FROM institution_staff s JOIN institutions i ON i.id = s.institution_id
        WHERE s.id = $1 AND s.institution_id = $2`, [challenge.sub, challenge.institutionId]
    )
    const staff = rows[0]
    if (!staff || !staff.is_active || staff.institution_status !== 'ACTIVE') return null
    return { kind: 'INSTITUTION', row: staff, table: 'institution_staff', id: staff.id }
  }
  const { rows } = await query(
    `SELECT u.id, u.tenant_id, u.merchant_id, t.company_name AS tenant_company_name,
            u.email, u.first_name, u.last_name, u.role,
            u.is_active, u.mfa_enabled, u.mfa_secret_encrypted, u.mfa_pending_secret_encrypted,
            u.token_version, t.status AS tenant_status
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`, [challenge.sub]
  )
  const user = rows[0]
  if (!user || !user.is_active || user.tenant_status === 'SUSPENDED') return null
  return { kind: 'TENANT', row: user, table: 'users', id: user.id }
}

mfaRouter.post('/setup', async (req, res, next) => {
  try {
    const challenge = getChallenge(req)
    if (!challenge || challenge.mfaFlow !== 'ENROLL') return res.status(401).json({ message: 'A valid MFA enrollment challenge is required.' })
    const principal = await loadPrincipal(challenge)
    if (!principal) return res.status(401).json({ message: 'MFA enrollment challenge is no longer valid.' })
    if (principal.row.mfa_enabled) return res.status(409).json({ message: 'MFA is already enabled for this account.' })
    const secret = createTotpSecret()
    const encrypted = await encrypt(secret, principalContext(principal))
    await query(`UPDATE ${principal.table} SET mfa_pending_secret_encrypted = $2 WHERE id = $1`, [principal.id, encrypted])
    res.json({ secret, provisioningUri: totpProvisioningUri(secret, principal.row.email) })
  } catch (error) { next(error) }
})

mfaRouter.post('/verify', async (req, res, next) => {
  try {
    const challenge = getChallenge(req)
    if (!challenge) return res.status(401).json({ message: 'A valid MFA challenge is required.' })
    const principal = await loadPrincipal(challenge)
    if (!principal) return res.status(401).json({ message: 'MFA challenge is no longer valid.' })
    const isEnrollment = challenge.mfaFlow === 'ENROLL'
    const encrypted = isEnrollment ? principal.row.mfa_pending_secret_encrypted : principal.row.mfa_secret_encrypted
    if (!encrypted) return res.status(409).json({ message: 'Start MFA enrollment before verifying a code.' })
    const secret = await decrypt(encrypted, principalContext(principal))
    const validTotp = secret && secret !== encrypted && verifyTotp(secret, req.body?.code)
    let usedRecoveryCode = false
    if (!validTotp && !isEnrollment) {
      usedRecoveryCode = await consumeMfaRecoveryCode(principal.id, principal.kind, req.body?.recoveryCode, {
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
        requestId: req.id || null
      })
    }
    if (!validTotp && !usedRecoveryCode) {
      return res.status(401).json({ message: 'The authenticator code or recovery code is invalid or already used.' })
    }

    let recoveryCodes
    if (isEnrollment) {
      recoveryCodes = await enableMfaWithRecoveryCodes(principal.id, principal.kind)
    }
    const row = principal.row
    const session = principal.kind === 'INSTITUTION'
      ? await createSession({
          id: row.id,
          institution_id: row.institution_id,
          institution_staff_id: row.id,
          tenant_id: null,
          token_version: row.token_version,
          role: row.role,
          mfa: true
        }, req)
      : await createSession({
          id: row.id,
          institution_id: null,
          institution_staff_id: null,
          tenant_id: row.tenant_id,
          token_version: row.token_version,
          role: row.role,
          mfa: true
        }, req)
    if (principal.kind === 'INSTITUTION') {
      return res.json({ token: session, staff: { id: row.id, institutionId: row.institution_id, institutionName: row.institution_name, branchId: row.branch_id || null, firstName: row.first_name, lastName: row.last_name, email: row.email, role: row.role }, ...(recoveryCodes ? { recoveryCodes } : {}), recoveryCodeUsed: usedRecoveryCode })
    }
    const response = { user: { id: row.id, tenantId: row.tenant_id, merchantId: row.merchant_id || null, tenantCompanyName: row.tenant_company_name || null, firstName: row.first_name, lastName: row.last_name, email: row.email, role: row.role, isPlatformAdmin: row.role === 'PLATFORM_ADMIN' }, ...(recoveryCodes ? { recoveryCodes } : {}), recoveryCodeUsed: usedRecoveryCode }
    if (row.role === 'PLATFORM_ADMIN') setAdminSessionCookie(res, session)
    else response.token = session
    res.json(response)
  } catch (error) { next(error) }
})
