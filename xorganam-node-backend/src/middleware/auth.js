import { query } from '../db/pool.js'
import { isMfaRequired } from '../services/mfaPolicy.js'
import { ROLE_PERMISSIONS } from '../constants/permissions.js'
import { validateSessionToken } from '../services/sessionService.js'

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
    payload = await validateSessionToken(header.slice('Bearer '.length))
  } catch {
    return res.status(401).json({ message: 'Invalid or expired session.' })
  }
  try {
    if (payload.mfa !== true && await isMfaRequired('TENANT', payload.sub)) {
      return res.status(401).json({ message: 'A verified MFA session is required.' })
    }
    const { rows } = await query(
      `SELECT u.id, u.tenant_id, u.merchant_id, u.role, u.is_active, u.first_name, u.last_name, u.email, t.status AS tenant_status,
              u.token_version
         FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
      [payload.sub]
    )

    if (rows.length === 0 || !rows[0].is_active) {
      return res.status(401).json({ message: 'Invalid or expired session.' })
    }

    const user = rows[0]
    if (user.token_version !== payload.tokenVersion) {
      return res.status(401).json({ message: 'Invalid or expired session.' })
    }
    if (user.tenant_id && user.tenant_status === 'SUSPENDED') {
      return res.status(403).json({ message: 'Tenant access is suspended.' })
    }
    req.user = {
      id: user.id,
      tenantId: user.tenant_id,
      merchantId: user.merchant_id,
      role: user.role,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      isPlatformAdmin: user.role === 'PLATFORM_ADMIN',
      sessionId: payload.sessionId
    }
    next()
  } catch (err) {
    console.error('[auth] failed to load user for token', { code: err?.code || 'DB_ERROR' })
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

export function requireAnyRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Authentication required.' })
    if (req.user.isPlatformAdmin || roles.includes(req.user.role)) return next()
    return res.status(403).json({ message: 'You do not have permission to do this.' })
  }
}

export function requireOwnMerchantIfBranchManager(req, res, next) {
  if (req.user?.role !== 'TENANT_BRANCH_MANAGER') return next()
  const merchantId = req.params.merchantId || req.query.merchantId || req.body?.merchantId
  if (!req.user.merchantId || String(merchantId) !== String(req.user.merchantId)) {
    return res.status(403).json({ message: 'Branch managers can only access their assigned merchant.' })
  }
  next()
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

/**
 * Checks if a user has a specific permission.
 * @param userId The user ID to check
 * @param permissionType The permission type (e.g., 'EDIT_MERCHANTS')
 * @param resourceId Optional resource ID (e.g., merchant ID)
 * @returns true if the user has the permission, false otherwise
 */
export async function userHasPermission(userId, permissionType, resourceId = null, role = null) {
  if (role === 'PLATFORM_ADMIN' || role === 'TENANT_ADMIN') return true
  if (ROLE_PERMISSIONS[role]?.includes(permissionType)) return true
  const { rows } = await query(
    `SELECT 1 FROM user_permissions
      WHERE user_id = $1
        AND permission_type = $2
        AND (resource_id IS NULL OR ($3::uuid IS NOT NULL AND resource_id = $3))
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1`,
    [userId, permissionType, resourceId]
  )
  return rows.length > 0
}

/**
 * Middleware to check if a user has a specific permission.
 * Usage: router.post('/edit', authenticate, requirePermission('EDIT_MERCHANTS'), handler)
 */
export function requirePermission(permissionType) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Authentication required.' })
    
    // Platform admins always have all permissions
    if (req.user.isPlatformAdmin) return next()

    // Check if user has the permission
    try {
      const resourceId = req.params.merchantId || req.query.merchantId || req.body?.merchantId || null
      if (resourceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(resourceId))) {
        return res.status(400).json({ message: 'merchantId must be a valid UUID.' })
      }
      const hasPermission = await userHasPermission(req.user.id, permissionType, resourceId, req.user.role)
      if (!hasPermission) {
        return res.status(403).json({ message: `You do not have ${permissionType} permission.` })
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Middleware to check if a user has permission for a specific resource.
 * Usage: router.post('/merchants/:merchantId/edit', authenticate, requireResourcePermission('EDIT_MERCHANTS', 'merchantId'), handler)
 */
export function requireResourcePermission(permissionType, resourceIdParam) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Authentication required.' })
    
    // Platform admins always have all permissions
    if (req.user.isPlatformAdmin) return next()

    const resourceId = req.params[resourceIdParam] || req.body[resourceIdParam] || req.query[resourceIdParam]
    if (!resourceId) {
      return res.status(400).json({ message: `${resourceIdParam} is required.` })
    }

    try {
      const hasPermission = await userHasPermission(req.user.id, permissionType, resourceId, req.user.role)
      if (!hasPermission) {
        return res.status(403).json({ message: `You do not have ${permissionType} permission for this resource.` })
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}
