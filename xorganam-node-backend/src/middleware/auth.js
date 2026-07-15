import { verifyToken } from '../security/jwt.js'
import { query } from '../db/pool.js'

/**
 * Verifies the Bearer token and attaches req.user = { id, tenantId, role }.
 * Also re-checks the user is still active in the database on every request
 * rather than trusting only the JWT claims - a deactivated user's existing
 * token is rejected immediately rather than staying valid until it expires.
 */
export async function authenticate(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required.' })
  }

  let payload
  try {
    payload = verifyToken(header.slice('Bearer '.length))
  } catch {
    return res.status(401).json({ message: 'Invalid or expired session.' })
  }

  try {
    const { rows } = await query(
      `SELECT id, tenant_id, role, is_active, first_name, last_name, email FROM users WHERE id = $1`,
      [payload.sub]
    )

    if (rows.length === 0 || !rows[0].is_active) {
      return res.status(401).json({ message: 'Invalid or expired session.' })
    }

    const user = rows[0]
    req.user = {
      id: user.id,
      tenantId: user.tenant_id,
      role: user.role,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      isPlatformAdmin: user.role === 'PLATFORM_ADMIN'
    }
    next()
  } catch (err) {
    console.error('[auth] failed to load user for token', err)
    res.status(500).json({ message: 'Authentication failed.' })
  }
}

const ROLE_RANK = {
  PLATFORM_ADMIN: 100,
  TENANT_ADMIN: 40,
  TENANT_MANAGER: 30,
  TENANT_OPERATOR: 20,
  TENANT_VIEWER: 10
}

/**
 * Gates a route to a minimum role rank. PLATFORM_ADMIN always passes.
 * Usage: router.get('/x', authenticate, requireRole('TENANT_MANAGER'), handler)
 */
export function requireRole(minimumRole) {
  const minimumRank = ROLE_RANK[minimumRole]
  if (minimumRank === undefined) {
    throw new Error(`Unknown role in requireRole(): ${minimumRole}`)
  }

  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Authentication required.' })

    if (req.user.isPlatformAdmin) return next()

    const userRank = ROLE_RANK[req.user.role] ?? 0
    if (userRank < minimumRank) {
      return res.status(403).json({ message: 'You do not have permission to do this.' })
    }
    next()
  }
}

/**
 * Restricts a route to PLATFORM_ADMIN only.
 */
export function requirePlatformAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ message: 'Authentication required.' })
  if (!req.user.isPlatformAdmin) return res.status(403).json({ message: 'Platform admin only.' })
  next()
}

export class ForbiddenError extends Error {}

/**
 * Resolves which tenant the current request should operate on, and
 * enforces that a non-platform-admin user can only ever act on their own
 * tenant - even if a different tenantId is supplied via route param,
 * query string, or body. This is the single choke point every route in
 * this backend uses for tenant scoping, so the rule can't be forgotten
 * or re-implemented inconsistently per-route.
 *
 * @param req Express request, must run after authenticate()
 * @param requestedTenantId tenantId taken from params/query/body, or undefined
 * @returns the tenantId to actually use
 * @throws {ForbiddenError} if a non-admin tries to access another tenant
 */
export function resolveTenantScope(req, requestedTenantId) {
  if (req.user.isPlatformAdmin) {
    if (!requestedTenantId) {
      throw new ForbiddenError('tenantId is required for platform admin requests.')
    }
    return requestedTenantId
  }

  if (requestedTenantId && requestedTenantId !== req.user.tenantId) {
    throw new ForbiddenError("You cannot access another tenant's data.")
  }

  return req.user.tenantId
}
