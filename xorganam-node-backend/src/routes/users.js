import { Router } from 'express'
import { query } from '../db/pool.js'
import { hashPassword } from '../security/password.js'
import { authenticate, requireRole, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { isValidPermissionType } from '../constants/permissions.js'

export const usersRouter = Router()

usersRouter.use(authenticate)

const ASSIGNABLE_ROLES = ['TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_OPERATOR', 'TENANT_VIEWER']

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

usersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    let rows
    const { merchantId } = req.query
    
    if (req.user.isPlatformAdmin && req.query.tenantId) {
      const sql = merchantId
        ? `SELECT id, tenant_id, merchant_id, first_name, last_name, email, phone_number, role, is_active, created_at, last_login_at
             FROM users WHERE tenant_id = $1 AND merchant_id = $2 ORDER BY last_name`
        : `SELECT id, tenant_id, merchant_id, first_name, last_name, email, phone_number, role, is_active, created_at, last_login_at
             FROM users WHERE tenant_id = $1 ORDER BY last_name`
      ;({ rows } = await query(sql, merchantId ? [req.query.tenantId, merchantId] : [req.query.tenantId]))
    } else if (req.user.isPlatformAdmin) {
      ;({ rows } = await query(
        `SELECT id, tenant_id, merchant_id, first_name, last_name, email, phone_number, role, is_active, created_at, last_login_at
           FROM users ORDER BY last_name`
      ))
    } else {
      const sql = merchantId
        ? `SELECT id, tenant_id, merchant_id, first_name, last_name, email, phone_number, role, is_active, created_at, last_login_at
             FROM users WHERE tenant_id = $1 AND (merchant_id = $2 OR merchant_id IS NULL) ORDER BY last_name`
        : `SELECT id, tenant_id, merchant_id, first_name, last_name, email, phone_number, role, is_active, created_at, last_login_at
             FROM users WHERE tenant_id = $1 ORDER BY last_name`
      ;({ rows } = await query(sql, merchantId ? [req.user.tenantId, merchantId] : [req.user.tenantId]))
    }

    res.json(rows.map(mapUser))
  })
)

usersRouter.post(
  '/',
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const { firstName, lastName, email, phoneNumber, password, role, merchantId } = req.body || {}

    if (!firstName || !lastName || !email || !password || !role) {
      return res.status(400).json({ message: 'firstName, lastName, email, password, and role are required.' })
    }
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ message: `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` })
    }
    if (String(password).length < 10) {
      return res.status(400).json({ message: 'Password must be at least 10 characters.' })
    }

    const tenantId = scopeOrRespond(req, res, req.body.tenantId)
    if (!tenantId) return

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

    res.status(201).json(mapUser(rows[0]))
  })
)

usersRouter.put(
  '/:userId',
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const { firstName, lastName, phoneNumber, isActive, role } = req.body || {}

    const existing = await query('SELECT tenant_id, merchant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    const user = existing.rows[0]
    
    if (scopeOrRespond(req, res, user.tenant_id) === null) return

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
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const { isActive } = req.body || {}
    if (typeof isActive !== 'boolean') return res.status(400).json({ message: 'isActive (boolean) is required.' })

    const existing = await query('SELECT tenant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return

    await query('UPDATE users SET is_active = $2 WHERE id = $1', [req.params.userId, isActive])
    res.json({ message: 'User status updated.', userId: req.params.userId, isActive })
  })
)

usersRouter.post(
  '/:userId/suspend',
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT tenant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return

    await query('UPDATE users SET is_active = false WHERE id = $1', [req.params.userId])
    res.json({ message: 'User suspended.', userId: req.params.userId, isActive: false })
  })
)

usersRouter.post(
  '/:userId/enable',
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT tenant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return

    await query('UPDATE users SET is_active = true WHERE id = $1', [req.params.userId])
    res.json({ message: 'User enabled.', userId: req.params.userId, isActive: true })
  })
)

usersRouter.post(
  '/:userId/assign-role',
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const { role } = req.body || {}
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ message: `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` })
    }

    const existing = await query('SELECT tenant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return

    await query('UPDATE users SET role = $2 WHERE id = $1', [req.params.userId, role])
    res.json({ message: 'Role updated.', userId: req.params.userId, role })
  })
)

// =====================================================================
// Permission Management Endpoints
// =====================================================================

usersRouter.get(
  '/:userId/permissions',
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT tenant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return

    const { rows } = await query(
      `SELECT id, permission_type, resource_id, granted_at, granted_by_user_id
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
      grantedByUserId: p.granted_by_user_id
    })))
  })
)

usersRouter.post(
  '/:userId/permissions',
  requireRole('TENANT_ADMIN'),
  asyncHandler(async (req, res) => {
    const { permissionType, resourceId } = req.body || {}
    if (!permissionType) return res.status(400).json({ message: 'permissionType is required.' })
    
    // Validate permission type
    if (!isValidPermissionType(permissionType)) {
      return res.status(400).json({ message: `Invalid permissionType. Must be one of the defined permission types.` })
    }

    const existing = await query('SELECT tenant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    const user = existing.rows[0]
    
    if (scopeOrRespond(req, res, user.tenant_id) === null) return

    try {
      const { rows } = await query(
        `INSERT INTO user_permissions (user_id, tenant_id, permission_type, resource_id, granted_by_user_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, permission_type, resource_id) DO NOTHING
         RETURNING id, permission_type, resource_id, granted_at, granted_by_user_id`,
        [req.params.userId, user.tenant_id, permissionType, resourceId || null, req.user.id]
      )

      if (rows.length === 0) {
        return res.status(409).json({ message: 'This permission already exists.' })
      }

      const p = rows[0]
      res.status(201).json({
        id: p.id,
        permissionType: p.permission_type,
        resourceId: p.resource_id,
        grantedAt: p.granted_at,
        grantedByUserId: p.granted_by_user_id
      })
    } catch (err) {
      console.error('Error granting permission:', err)
      res.status(400).json({ message: 'Failed to grant permission.', detail: err.message })
    }
  })
)

usersRouter.delete(
  '/:userId/permissions/:permissionId',
  requireRole('TENANT_ADMIN'),
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT tenant_id FROM users WHERE id = $1', [req.params.userId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return

    const perm = await query(
      'SELECT user_id FROM user_permissions WHERE id = $1',
      [req.params.permissionId]
    )
    if (perm.rows.length === 0) return res.status(404).json({ message: 'Permission not found.' })
    if (perm.rows[0].user_id !== req.params.userId) {
      return res.status(403).json({ message: 'Permission does not belong to this user.' })
    }

    await query('DELETE FROM user_permissions WHERE id = $1', [req.params.permissionId])
    res.json({ message: 'Permission revoked.', permissionId: req.params.permissionId })
  })
)

// =====================================================================
// Assign User to Merchant
// =====================================================================

usersRouter.post(
  '/:userId/assign-merchant',
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const { merchantId } = req.body || {}
    if (!merchantId) return res.status(400).json({ message: 'merchantId is required.' })

    const user = await query('SELECT tenant_id FROM users WHERE id = $1', [req.params.userId])
    if (user.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, user.rows[0].tenant_id) === null) return

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
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const user = await query('SELECT tenant_id FROM users WHERE id = $1', [req.params.userId])
    if (user.rows.length === 0) return res.status(404).json({ message: 'User not found.' })
    if (scopeOrRespond(req, res, user.rows[0].tenant_id) === null) return

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
    phoneNumber: row.phone_number,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at
  }
}
