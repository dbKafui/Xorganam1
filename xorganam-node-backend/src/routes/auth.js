import { Router } from 'express'
import { query } from '../db/pool.js'
import { verifyPassword } from '../security/password.js'
import { signToken } from '../security/jwt.js'
import { authenticate } from '../middleware/auth.js'

export const authRouter = Router()

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body || {}

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' })
  }

  const { rows } = await query(
    `SELECT u.id, u.tenant_id, u.first_name, u.last_name, u.email, u.password_hash, u.role, u.is_active,
            t.company_name AS tenant_company_name
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.email = $1`,
    [String(email).toLowerCase().trim()]
  )

  if (rows.length === 0) {
    return res.status(401).json({ message: 'Invalid email or password.' })
  }

  const user = rows[0]

  if (!user.is_active) {
    return res.status(401).json({ message: 'This account has been deactivated.' })
  }

  const valid = await verifyPassword(password, user.password_hash)
  if (!valid) {
    return res.status(401).json({ message: 'Invalid email or password.' })
  }

  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id])

  const token = signToken({ id: user.id, tenantId: user.tenant_id, role: user.role })

  res.json({
    token,
    user: mapUser(user)
  })
})

authRouter.get('/me', authenticate, async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.tenant_id, u.first_name, u.last_name, u.email, u.role, u.is_active,
            t.company_name AS tenant_company_name
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = $1`,
    [req.user.id]
  )

  if (rows.length === 0) return res.status(401).json({ message: 'Session no longer valid.' })

  res.json(mapUser(rows[0]))
})

function mapUser(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantCompanyName: row.tenant_company_name || null,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    role: row.role,
    isPlatformAdmin: row.role === 'PLATFORM_ADMIN'
  }
}
