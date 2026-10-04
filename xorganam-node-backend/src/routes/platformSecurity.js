import { Router } from 'express'
import { query } from '../db/pool.js'
import { authenticate, requirePlatformAdmin } from '../middleware/auth.js'
import { isMfaRequired } from '../services/mfaPolicy.js'

export const platformSecurityRouter = Router()
platformSecurityRouter.use(authenticate, requirePlatformAdmin)

platformSecurityRouter.get('/mfa-exemptions', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT 'TENANT' AS principal_type, u.id, u.email, u.role::text AS role,
              COALESCE(e.enabled, FALSE) AS exempt
         FROM users u
         LEFT JOIN platform_demo_mfa_exemptions e
           ON e.principal_type = 'TENANT' AND e.principal_id = u.id
        WHERE u.email LIKE '%@xorganam.test'
       UNION ALL
       SELECT 'INSTITUTION' AS principal_type, s.id, s.email, s.role::text AS role,
              COALESCE(e.enabled, FALSE) AS exempt
         FROM institution_staff s
         LEFT JOIN platform_demo_mfa_exemptions e
           ON e.principal_type = 'INSTITUTION' AND e.principal_id = s.id
        WHERE s.email LIKE '%@xorganam.test'
       ORDER BY email`
    )
    res.json({ accounts: rows.map((row) => ({
      type: row.principal_type,
      id: row.id,
      email: row.email,
      role: row.role,
      mfaExempt: row.exempt
    })) })
  } catch (error) { next(error) }
})

platformSecurityRouter.put('/mfa-exemptions/:type/:id', async (req, res, next) => {
  try {
    const type = String(req.params.type).toUpperCase()
    const { id } = req.params
    const { exempt } = req.body || {}
    if (!['TENANT', 'INSTITUTION'].includes(type) || typeof exempt !== 'boolean') {
      return res.status(400).json({ message: 'A demo account type and boolean exempt value are required.' })
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ message: 'A valid demo account ID is required.' })
    }
    const eligible = type === 'INSTITUTION'
      ? await query("SELECT id FROM institution_staff WHERE id = $1 AND email LIKE '%@xorganam.test'", [id])
      : await query("SELECT id FROM users WHERE id = $1 AND email LIKE '%@xorganam.test'", [id])
    if (!eligible.rows.length) return res.status(404).json({ message: 'Demo account not found.' })
    const { rows } = await query(
      `INSERT INTO platform_demo_mfa_exemptions
         (principal_type, principal_id, enabled, updated_by_user_id, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (principal_type, principal_id) DO UPDATE
         SET enabled = EXCLUDED.enabled, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
       RETURNING enabled, updated_at`,
      [type, id, exempt, req.user.id]
    )
    res.json({ mfaExempt: rows[0].enabled, updatedAt: rows[0].updated_at })
  } catch (error) { next(error) }
})
