import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

const EXPIRY = process.env.JWT_EXPIRY || '8h'

/**
 * @param {{ id: string, tenantId: string|null, role: string, institutionId?: string, institutionStaffId?: string }} user
 */
export function signToken(user) {
  const payload = {
    sub: user.id,
    tenantId: user.tenantId ?? null,
    role: user.role
  }

  if (user.institutionId) payload.institutionId = user.institutionId
  if (user.institutionStaffId) payload.institutionStaffId = user.institutionStaffId

  return jwt.sign(payload, env.jwt.secret, { expiresIn: EXPIRY, issuer: 'xorganam', audience: 'xorganam-clients' })
}

/**
 * @returns {{ sub: string, tenantId: string|null, role: string, institutionId?: string, institutionStaffId?: string }}
 * @throws if the token is missing, expired, or has an invalid signature
 */
export function verifyToken(token) {
  return jwt.verify(token, env.jwt.secret, { issuer: 'xorganam', audience: 'xorganam-clients' })
}
