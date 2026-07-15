import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

const EXPIRY = process.env.JWT_EXPIRY || '8h'

/**
 * @param {{ id: string, tenantId: string|null, role: string }} user
 */
export function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role
    },
    env.jwt.secret,
    { expiresIn: EXPIRY, issuer: 'xorganam', audience: 'xorganam-clients' }
  )
}

/**
 * @returns {{ sub: string, tenantId: string|null, role: string }}
 * @throws if the token is missing, expired, or has an invalid signature
 */
export function verifyToken(token) {
  return jwt.verify(token, env.jwt.secret, { issuer: 'xorganam', audience: 'xorganam-clients' })
}
