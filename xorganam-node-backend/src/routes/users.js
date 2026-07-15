import { Router } from 'express'
import { query } from '../db/pool.js'
import { hashPassword } from '../security/password.js'
import { authenticate, requireRole, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'

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
    if (req.user.isPlatformAdmin && req.query.tenantId) {
      ;({ rows } = await query(
        `SELECT id, tenant_id, first_name, last_name, email, phone_number, role, is_active, created_at, last_login_at
           FROM users WHERE tenant_id = $1 ORDER BY last_name`,
        [req.query.tenantId]
      ))
    } else if (req.user.isPlatformAdmin) {
      ;({ rows } = await query(
        `SELECT id, tenant_id, first_name, last_name, email, phone_number, role, is_active, created_at, last_login_at
           FROM users ORDER BY last_name`
      ))
    } else {
      ;({ rows } = await query(
        `SELECT id, tenant_id, first_name, last_name, email, phone_number, role, is_active, created_at, last_login_at
           FROM users WHERE tenant_id = $1 ORDER BY last_name`,
        [req.user.tenantId]
      ))
    }

    res.json(rows.map(mapUser))
  })
)

usersRouter.post(
  '/',
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const { firstName, lastName, email, phoneNumber, password, role } = req.body || {}

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

    const normalizedEmail = String(email).toLowerCase().trim()
    const existing = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail])
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: 'A user with this email already exists.' })
    }

    const passwordHash = await hashPassword(password)

    const { rows } = await query(
      `INSERT INTO users (tenant_id, first_name, last_name, email, phone_number, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
       RETURNING id, tenant_id, first_name, last_name, email, phone_number, role, is_active, created_at, last_login_at`,
      [tenantId, firstName, lastName, normalizedEmail, phoneNumber || null, passwordHash, role]
    )

    res.status(201).json(mapUser(rows[0]))
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

function mapUser(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
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
