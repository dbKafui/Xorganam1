import { Router } from 'express'
import { query } from '../db/pool.js'
import { hashPassword } from '../security/password.js'
import { authenticate, requireRole, requirePermission, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { isValidPermissionType } from '../constants/permissions.js'
import { requestEmailVerification } from '../services/emailVerificationService.js'
import { writePlatformAudit } from '../services/auditService.js'
import { normalizePermissionExpiry } from '../services/permissionPolicy.js'
import { withTransaction } from '../db/pool.js'

export const usersRouter = Router()

usersRouter.use(authenticate)

const ASSIGNABLE_ROLES = ['TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_OPERATOR', 'TENANT_VIEWER', 'TENANT_BRANCH_MANAGER']
const ROLE_LEVEL = { TENANT_VIEWER: 10, TENANT_OPERATOR: 20, TENANT_BRANCH_MANAGER: 25, TENANT_MANAGER: 30, TENANT_ADMIN: 40, PLATFORM_ADMIN: 100 }
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function scopeOrRespond(req, res, requestedTenantId) {
  try {
    return resolveTenantScope(req, requestedTenantId)
  } catch (err) {
    if (err instanceof ForbiddenError) {
      res.status(403).json({ message: err.message })
      return null
    }
    throw err
  }
}

function enforceAssignedMerchant(req, res, merchantId) {
  if (!req.user.merchantId) return true
  if (String(req.user.merchantId) === String(merchantId)) return true
  res.status(403).json({ message: 'You can only manage users assigned to your merchant.' })
  return false
}

usersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    if (req.user.role === 'TENANT_BRANCH_MANAGER') return res.status(403).json({ message: 'Branch managers cannot view tenant staff.' })
    let rows
    const { merchantId } = req.query
    
    if (req.user.isPlatformAdmin && req.query.tenantId) {
      const sql = merchantId
           ? `SELECT id, tenant_id, merchant_id, first_name, last_name, email, email_verified_at, phone_number, role, is_active, created_at, last_login_at
             FROM users WHERE tenant_id = $1 AND merchant_id = $2 ORDER BY last_name`
           : `SELECT id, tenant_id, merchant_id, first_name, last_name, email, email_verified_at, phone_number, role, is_active, created_at, last_login_at
             FROM users WHERE tenant_id = $1 ORDER BY last_name`
      ;({ rows } = await query(sql, merchantId ? [req.query.tenantId, merchantId] : [req.query.tenantId]))
    } else if (req.user.isPlatformAdmin) {
      ;({ rows } = await query(
        `SELECT id, tenant_id, merchant_id, first_name, last_name, email, email_verified_at, phone_number, role, is_active, created_at, last_login_at
           FROM users ORDER BY last_name`
      ))
    } else if (req.user.merchantId) {
      ;({ rows } = await query(
        `SELECT id, tenant_id, merchant_id, first_name, last_name, email, email_verified_at, phone_number, role, is_active, created_at, last_login_at
           FROM users WHERE tenant_id = $1 AND merchant_id = $2 ORDER BY last_name`,
        [req.user.tenantId, req.user.merchantId]
      ))
    } else {
      const sql = merchantId
           ? `SELECT id, tenant_id, merchant_id, first_name, last_name, email, email_verified_at, phone_number, role, is_active, created_at, last_login_at
             FROM users WHERE tenant_id = $1 AND (merchant_id = $2 OR merchant_id IS NULL) ORDER BY last_name`
           : `SELECT id, tenant_id, merchant_id, first_name, last_name, email, email_verified_at, phone_number, role, is_active, created_at, last_login_at
             FROM users WHERE tenant_id = $1 ORDER BY last_name`
      ;({ rows } = await query(sql, merchantId ? [req.user.tenantId, merchantId] : [req.user.tenantId]))
    }

    res.json(rows.map(mapUser))
  })
)

usersRouter.post(
  '/',
  requirePermission('MANAGE_TEAM'),
  asyncHandler(async (req, res) => {
    const { firstName, lastName, email, phoneNumber, password, role, merchantId } = req.body || {}

    if (!firstName || !lastName || !email || !password || !role) {
      return res.status(400).json({ message: 'firstName, lastName, email, password, and role are required.' })
    }
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ message: `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` })
    }
    if ((ROLE_LEVEL[role] || 0) > (ROLE_LEVEL[req.user.role] || 0)) {
      return res.status(403).json({ message: 'You cannot create a user with a higher role than your own.' })
    }
    if (role === 'TENANT_BRANCH_MANAGER' && !merchantId) {
      return res.status(400).json({ message: 'A branch manager must be assigned to a merchant.' })
    }
    if (String(password).length < 10) {
      return res.status(400).json({ message: 'Password must be at least 10 characters.' })
    }

    const tenantId = scopeOrRespond(req, res, req.body.tenantId)
    if (!tenantId) return
    if (req.user.merchantId && String(req.user.merchantId) !== String(merchantId || '')) {
      return res.status(403).json({ message: 'You can only create users assigned to your merchant.' })
    }

    // If merchantId provided, verify it belongs to this tenant
    if (merchantId) {
      const merchantCheck = await query(
        'SELECT tenant_id FROM merchants WHERE id = $1',
        [merchantId]
      )
      if (merchantCheck.rows.length === 0) {
        return res.status(404).json({ message: 'Merchant not found.' })
      }
      if (merchantCheck.rows[0].tenant_id !== tenantId) {
        return res.status(403).json({ message: 'Merchant does not belong to this tenant.' })
      }
    }

    const normalizedEmail = String(email).toLowerCase().trim()
    const existing = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail])
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: 'A user with this email already exists.' })
    }

    const passwordHash = await hashPassword(password)

    const { rows } = await query(
      `INSERT INTO users (tenant_id, merchant_id, first_name, last_name, email, phone_number, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
       RETURNING id, tenant_id, merchant_id, first_name, last_name, email, phone_number, role, is_active, created_at, last_login_at`,
      [tenantId, merchantId || null, firstName, lastName, normalizedEmail, phoneNumber || null, passwordHash, role]
    )

    const verification = await requestEmailVerification(normalizedEmail)
    res.status(201).json({ ...mapUser(rows[0]), emailVerificationSent: verification.delivered })
  })
)

usersRouter.put(
  '/:userId',
  requirePermission('MANAGE_TEAM'),
  asyncHandler(async (req, res) => {
    const { firstName, lastName, phoneNumber, isActive, role } = req.body || {}

    const existing = await query('SELECT tenant_id, merchant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    const user = existing.rows[0]
    
    if (scopeOrRespond(req, res, user.tenant_id) === null) return
    if (!enforceAssignedMerchant(req, res, user.merchant_id)) return
    if (role !== undefined && !ASSIGNABLE_ROLES.includes(role)) return res.status(400).json({ message: 'Role is invalid.' })
    if (role && (ROLE_LEVEL[role] || 0) > (ROLE_LEVEL[req.user.role] || 0)) {
      return res.status(403).json({ message: 'You cannot assign a higher role than your own.' })
    }
    if (role === 'TENANT_BRANCH_MANAGER' && !user.merchant_id) {
      return res.status(400).json({ message: 'Assign this user to a merchant before giving them the branch manager role.' })
    }

    const updates = []
    const params = [req.params.userId]
    let paramIndex = 2

    if (firstName !== undefined) {
      updates.push(`first_name = $${paramIndex++}`)
      params.push(firstName)
    }
    if (lastName !== undefined) {
      updates.push(`last_name = $${paramIndex++}`)
      params.push(lastName)
    }
    if (phoneNumber !== undefined) {
      updates.push(`phone_number = $${paramIndex++}`)
      params.push(phoneNumber || null)
    }
    if (isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`)
      params.push(isActive)
    }
    if (role !== undefined && ASSIGNABLE_ROLES.includes(role)) {
      updates.push(`role = $${paramIndex++}`)
      params.push(role)
    }

    if (updates.length === 0) {
      return res.status(400).json({ message: 'No valid fields to update.' })
    }

    updates.push('updated_at = now()')
    const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = $1 
                 RETURNING id, tenant_id, merchant_id, first_name, last_name, email, phone_number, role, is_active, created_at, last_login_at`

    const { rows } = await query(sql, params)
    res.json(mapUser(rows[0]))
  })
)

usersRouter.put(
  '/:userId/status',
  requirePermission('MANAGE_TEAM'),
  asyncHandler(async (req, res) => {
    const { isActive } = req.body || {}
    if (typeof isActive !== 'boolean') return res.status(400).json({ message: 'isActive (boolean) is required.' })

    const existing = await query('SELECT tenant_id, merchant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return
    if (!enforceAssignedMerchant(req, res, existing.rows[0].merchant_id)) return

    await query('UPDATE users SET is_active = $2 WHERE id = $1', [req.params.userId, isActive])
    res.json({ message: 'User status updated.', userId: req.params.userId, isActive })
  })
)

usersRouter.post(
  '/:userId/suspend',
  requirePermission('MANAGE_TEAM'),
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT tenant_id, merchant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return
    if (!enforceAssignedMerchant(req, res, existing.rows[0].merchant_id)) return

    await query('UPDATE users SET is_active = false WHERE id = $1', [req.params.userId])
    res.json({ message: 'User suspended.', userId: req.params.userId, isActive: false })
  })
)

usersRouter.post(
  '/:userId/enable',
  requirePermission('MANAGE_TEAM'),
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT tenant_id, merchant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return
    if (!enforceAssignedMerchant(req, res, existing.rows[0].merchant_id)) return

    await query('UPDATE users SET is_active = true WHERE id = $1', [req.params.userId])
    res.json({ message: 'User enabled.', userId: req.params.userId, isActive: true })
  })
)

usersRouter.post(
  '/:userId/assign-role',
  requirePermission('MANAGE_TEAM'),
  asyncHandler(async (req, res) => {
    const { role } = req.body || {}
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ message: `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` })
    }
    if ((ROLE_LEVEL[role] || 0) > (ROLE_LEVEL[req.user.role] || 0)) {
      return res.status(403).json({ message: 'You cannot assign a higher role than your own.' })
    }

    const existing = await query('SELECT tenant_id, merchant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return
    if (!enforceAssignedMerchant(req, res, existing.rows[0].merchant_id)) return

    const existingUser = await query('SELECT merchant_id FROM users WHERE id = $1', [req.params.userId])
    if (role === 'TENANT_BRANCH_MANAGER' && !existingUser.rows[0].merchant_id) {
      return res.status(400).json({ message: 'Assign this user to a merchant before giving them the branch manager role.' })
    }
    await query('UPDATE users SET role = $2 WHERE id = $1', [req.params.userId, role])
    res.json({ message: 'Role updated.', userId: req.params.userId, role })
  })
)

// =====================================================================
// Permission Management Endpoints
// =====================================================================

usersRouter.post(
  '/permissions/bulk',
  requireRole('TENANT_ADMIN'),
  requirePermission('MANAGE_PERMISSIONS'),
  asyncHandler(async (req, res) => {
    const { userIds, permissionType, resourceId, expiresAt } = req.body || {}
    if (!Array.isArray(userIds) || userIds.length < 1 || userIds.length > 100
      || userIds.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))
      || userIds.includes(req.user.id)) {
      return res.status(400).json({ message: 'userIds must contain 1 to 100 valid user IDs.' })
    }
    if (!permissionType || !isValidPermissionType(permissionType)) {
      return res.status(400).json({ message: 'A valid permissionType is required.' })
    }
    const uniqueUserIds = [...new Set(userIds)]
    let normalizedExpiresAt
    try {
      normalizedExpiresAt = normalizePermissionExpiry(expiresAt)
    } catch (error) {
      return res.status(400).json({ message: error.message })
    }

    const tenantId = scopeOrRespond(req, res, req.body?.tenantId)
    if (!tenantId) return
    if (resourceId) {
      if (typeof resourceId !== 'string' || !UUID_PATTERN.test(resourceId)) {
        return res.status(400).json({ message: 'resourceId must be a valid merchant UUID.' })
      }
      const merchant = await query('SELECT 1 FROM merchants WHERE id = $1 AND tenant_id = $2', [resourceId, tenantId])
      if (!merchant.rows.length) return res.status(400).json({ message: 'resourceId must identify a merchant in this tenant.' })
    }

    const result = await withTransaction(async (tx) => {
      const { rows: users } = await tx(
        'SELECT id, tenant_id, merchant_id FROM users WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE',
        [tenantId, uniqueUserIds]
      )
      if (users.length !== uniqueUserIds.length) {
        return { invalidUsers: true }
      }
      if (req.user.merchantId && users.some((target) => String(target.merchant_id) !== String(req.user.merchantId))) {
        return { forbiddenScope: true }
      }

      const counts = { granted: 0, renewed: 0, alreadyActive: 0 }
      for (const target of users) {
        const inserted = await tx(
          `INSERT INTO user_permissions (user_id, tenant_id, permission_type, resource_id, granted_by_user_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING
           RETURNING id, expires_at`,
          [target.id, tenantId, permissionType, resourceId || null, req.user.id, normalizedExpiresAt]
        )
        let permission = inserted.rows[0]
        let action = 'permission.granted'
        let previousExpiry = null
        if (permission) {
          counts.granted += 1
        } else {
          const existingGrant = await tx(
            `SELECT id, expires_at FROM user_permissions
              WHERE user_id = $1 AND permission_type = $2
                AND resource_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
            [target.id, permissionType, resourceId || null]
          )
          const existingPermission = existingGrant.rows[0]
          if (existingPermission?.expires_at && new Date(existingPermission.expires_at) <= new Date()) {
            previousExpiry = existingPermission.expires_at
            const renewed = await tx(
              `UPDATE user_permissions
                  SET granted_at = now(), granted_by_user_id = $2, expires_at = $3
                WHERE id = $1 AND expires_at <= now()
                RETURNING id, expires_at`,
              [existingPermission.id, req.user.id, normalizedExpiresAt]
            )
            permission = renewed.rows[0]
            if (!permission) throw Object.assign(new Error('Permission changed while it was being renewed.'), { statusCode: 409 })
            action = 'permission.renewed'
            counts.renewed += 1
          } else {
            counts.alreadyActive += 1
            continue
          }
        }

        await writePlatformAudit({
          actorUserId: req.user.id,
          tenantId,
          merchantId: target.merchant_id,
          action,
          resourceType: 'user_permission',
          resourceId: String(permission.id),
          details: {
            permissionType,
            resourceId: resourceId || null,
            expiresAt: normalizedExpiresAt,
            previousExpiry,
            targetUserId: target.id
          },
          ipAddress: req.ip || null,
          userAgent: req.headers['user-agent'] || null,
          requestId: req.id || null,
          client: tx
        })
      }
      return counts
    })

    if (result.invalidUsers) return res.status(400).json({ message: 'All target users must belong to this tenant.' })
    if (result.forbiddenScope) return res.status(403).json({ message: 'You can only grant permissions to users assigned to your merchant.' })
    res.status(200).json(result)
  })
)

usersRouter.get(
  '/:userId/permissions',
  requireRole('TENANT_ADMIN'),
  requirePermission('MANAGE_PERMISSIONS'),
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT tenant_id, merchant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return
    if (!enforceAssignedMerchant(req, res, existing.rows[0].merchant_id)) return

    const { rows } = await query(
      `SELECT id, permission_type, resource_id, granted_at, granted_by_user_id, expires_at
         FROM user_permissions
        WHERE user_id = $1
        ORDER BY permission_type, granted_at DESC`,
      [req.params.userId]
    )
    res.json(rows.map(p => ({
      id: p.id,
      permissionType: p.permission_type,
      resourceId: p.resource_id,
      grantedAt: p.granted_at,
      grantedByUserId: p.granted_by_user_id,
      expiresAt: p.expires_at
    })))
  })
)

usersRouter.post(
  '/:userId/permissions',
  requireRole('TENANT_ADMIN'),
  requirePermission('MANAGE_PERMISSIONS'),
  asyncHandler(async (req, res) => {
    const { permissionType, resourceId, expiresAt } = req.body || {}
    if (!permissionType) return res.status(400).json({ message: 'permissionType is required.' })

    if (!isValidPermissionType(permissionType)) {
      return res.status(400).json({ message: 'Invalid permissionType. Must be one of the defined permission types.' })
    }
    let normalizedExpiresAt
    try {
      normalizedExpiresAt = normalizePermissionExpiry(expiresAt)
    } catch (error) {
      return res.status(400).json({ message: error.message })
    }

    const existing = await query('SELECT tenant_id, merchant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    const user = existing.rows[0]

    if (scopeOrRespond(req, res, user.tenant_id) === null) return
    if (resourceId) {
      const merchant = await query('SELECT 1 FROM merchants WHERE id = $1 AND tenant_id = $2', [resourceId, user.tenant_id])
      if (!merchant.rows.length) return res.status(400).json({ message: 'resourceId must identify a merchant in this tenant.' })
    }

    try {
      const p = await withTransaction(async (tx) => {
        const inserted = await tx(
          `INSERT INTO user_permissions (user_id, tenant_id, permission_type, resource_id, granted_by_user_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING
           RETURNING id, permission_type, resource_id, granted_at, granted_by_user_id, expires_at`,
          [req.params.userId, user.tenant_id, permissionType, resourceId || null, req.user.id, normalizedExpiresAt]
        )

        let permission = inserted.rows[0]
        let action = 'permission.granted'
        let previousExpiry = null
        if (!permission) {
          const existingGrant = await tx(
            `SELECT id, expires_at FROM user_permissions
              WHERE user_id = $1 AND permission_type = $2
                AND resource_id IS NOT DISTINCT FROM $3::uuid
              FOR UPDATE`,
            [req.params.userId, permissionType, resourceId || null]
          )
          const existingPermission = existingGrant.rows[0]
          if (!existingPermission || !existingPermission.expires_at || new Date(existingPermission.expires_at) > new Date()) {
            throw Object.assign(new Error('This permission already exists and is still active.'), { statusCode: 409 })
          }
          previousExpiry = existingPermission.expires_at
          const renewed = await tx(
            `UPDATE user_permissions
                SET granted_at = now(), granted_by_user_id = $2, expires_at = $3
              WHERE id = $1 AND expires_at <= now()
              RETURNING id, permission_type, resource_id, granted_at, granted_by_user_id, expires_at`,
            [existingPermission.id, req.user.id, normalizedExpiresAt]
          )
          permission = renewed.rows[0]
          if (!permission) throw Object.assign(new Error('Permission changed while it was being renewed.'), { statusCode: 409 })
          action = 'permission.renewed'
        }

        await writePlatformAudit({
          actorUserId: req.user.id,
          tenantId: user.tenant_id,
          merchantId: user.merchant_id,
          action,
          resourceType: 'user_permission',
          resourceId: String(permission.id),
          details: {
            permissionType,
            resourceId: resourceId || null,
            expiresAt: normalizedExpiresAt,
            previousExpiry,
            targetUserId: req.params.userId
          },
          ipAddress: req.ip || null,
          userAgent: req.headers['user-agent'] || null,
          requestId: req.id || null,
          client: tx
        })

        return permission
      })

      res.status(201).json({
        id: p.id,
        permissionType: p.permission_type,
        resourceId: p.resource_id,
        grantedAt: p.granted_at,
        grantedByUserId: p.granted_by_user_id,
        expiresAt: p.expires_at
      })
    } catch (err) {
      if (err.statusCode === 409) return res.status(409).json({ message: err.message })
      console.error('Error granting permission', { code: err?.code || 'PERMISSION_ERROR' })
      res.status(400).json({ message: 'Failed to grant permission.', detail: err.message })
    }
  })
)

usersRouter.delete(
  '/:userId/permissions/:permissionId',
  requireRole('TENANT_ADMIN'),
  requirePermission('MANAGE_PERMISSIONS'),
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT tenant_id, merchant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return
    if (!enforceAssignedMerchant(req, res, existing.rows[0].merchant_id)) return

    const perm = await query(
      'SELECT user_id, tenant_id, permission_type, resource_id, expires_at FROM user_permissions WHERE id = $1',
      [req.params.permissionId]
    )
    if (perm.rows.length === 0) return res.status(404).json({ message: 'Permission not found.' })
    if (perm.rows[0].user_id !== req.params.userId) {
      return res.status(403).json({ message: 'Permission does not belong to this user.' })
    }

    await withTransaction(async (tx) => {
      await tx('DELETE FROM user_permissions WHERE id = $1', [req.params.permissionId])
      await writePlatformAudit({
        actorUserId: req.user.id,
        tenantId: perm.rows[0].tenant_id,
        merchantId: existing.rows[0].merchant_id,
        action: 'permission.revoked',
        resourceType: 'user_permission',
        resourceId: String(req.params.permissionId),
        details: {
          permissionType: perm.rows[0].permission_type,
          resourceId: perm.rows[0].resource_id,
          expiresAt: perm.rows[0].expires_at,
          targetUserId: req.params.userId
        },
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
        requestId: req.id || null,
        client: tx
      })
    })

    res.json({ message: 'Permission revoked.', permissionId: req.params.permissionId })
  })
)

usersRouter.get(
  '/:userId/permissions/history',
  requireRole('TENANT_ADMIN'),
  requirePermission('MANAGE_PERMISSIONS'),
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT tenant_id, merchant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return
    if (!enforceAssignedMerchant(req, res, existing.rows[0].merchant_id)) return

    const { rows } = await query(
      `SELECT id, action, resource_id, details, actor_user_id, created_at
         FROM platform_audit_log
        WHERE tenant_id = $1
          AND resource_type = 'user_permission'
          AND details->>'targetUserId' = $2
        ORDER BY created_at DESC
        LIMIT 50`,
      [existing.rows[0].tenant_id, req.params.userId]
    )

    res.json(rows.map((row) => ({
      id: row.id,
      action: row.action,
      permissionId: row.resource_id,
      permissionType: row.details?.permissionType || null,
      resourceId: row.details?.resourceId || null,
      expiresAt: row.details?.expiresAt || null,
      previousExpiry: row.details?.previousExpiry || null,
      targetUserId: row.details?.targetUserId || null,
      actorUserId: row.actor_user_id,
      createdAt: row.created_at
    })))
  })
)

// =====================================================================
// Assign User to Merchant
// =====================================================================

usersRouter.post(
  '/:userId/assign-merchant',
  requirePermission('MANAGE_TEAM'),
  asyncHandler(async (req, res) => {
    const { merchantId } = req.body || {}
    if (!merchantId) return res.status(400).json({ message: 'merchantId is required.' })

    const user = await query('SELECT tenant_id, role, merchant_id FROM users WHERE id = $1', [req.params.userId])
    if (user.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, user.rows[0].tenant_id) === null) return
    if (!enforceAssignedMerchant(req, res, user.rows[0].merchant_id)) return
    if (req.user.merchantId && String(req.user.merchantId) !== String(merchantId)) {
      return res.status(403).json({ message: 'You can only assign users to your merchant.' })
    }

    const merchant = await query('SELECT tenant_id FROM merchants WHERE id = $1', [merchantId])
    if (merchant.rows.length === 0) return res.status(404).json({ message: 'Merchant not found.' })
    if (merchant.rows[0].tenant_id !== user.rows[0].tenant_id) {
      return res.status(403).json({ message: 'Merchant does not belong to this tenant.' })
    }

    const { rows } = await query(
      `UPDATE users SET merchant_id = $2 WHERE id = $1
       RETURNING id, tenant_id, merchant_id, first_name, last_name, email, phone_number, role, is_active, created_at, last_login_at`,
      [req.params.userId, merchantId]
    )
    res.json(mapUser(rows[0]))
  })
)

usersRouter.post(
  '/:userId/unassign-merchant',
  requirePermission('MANAGE_TEAM'),
  asyncHandler(async (req, res) => {
    const user = await query('SELECT tenant_id, role, merchant_id FROM users WHERE id = $1', [req.params.userId])
    if (user.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, user.rows[0].tenant_id) === null) return
    if (!enforceAssignedMerchant(req, res, user.rows[0].merchant_id)) return
    if (req.user.merchantId) return res.status(403).json({ message: 'Merchant-assigned users cannot make accounts tenant-wide.' })
    if (user.rows[0].role === 'TENANT_BRANCH_MANAGER') return res.status(409).json({ message: 'Change this user role before removing their merchant assignment.' })

    const { rows } = await query(
      `UPDATE users SET merchant_id = NULL WHERE id = $1
       RETURNING id, tenant_id, merchant_id, first_name, last_name, email, phone_number, role, is_active, created_at, last_login_at`,
      [req.params.userId]
    )
    res.json(mapUser(rows[0]))
  })
)

function mapUser(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    merchantId: row.merchant_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    emailVerifiedAt: row.email_verified_at || null,
    phoneNumber: row.phone_number,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at
  }
}
