import { Router } from 'express'
import { query } from '../db/pool.js'
import { authenticate, requirePlatformAdmin } from '../middleware/auth.js'
import { buildPlatformAuditWhere, normalizePlatformAuditFilters } from '../services/platformAuditLogQuery.js'

export const platformSecurityRouter = Router()
platformSecurityRouter.use(authenticate, requirePlatformAdmin)

platformSecurityRouter.get('/audit-log', async (req, res, next) => {
  let filters
  try {
    filters = normalizePlatformAuditFilters(req.query)
  } catch (error) {
    return res.status(400).json({ message: error.message })
  }

  try {
    const { whereClause, params } = buildPlatformAuditWhere(filters)
    const count = await query(
      `SELECT COUNT(*)::int AS total_count FROM platform_audit_log a WHERE ${whereClause}`,
      params
    )
    const pageParams = [...params, filters.pageSize, (filters.page - 1) * filters.pageSize]
    const { rows } = await query(
      `SELECT a.id, a.actor_user_id, a.actor_institution_staff_id, a.tenant_id, a.merchant_id,
              a.action, a.resource_type, a.resource_id, a.details, a.ip_address,
              a.user_agent, a.request_id, a.created_at,
              u.email AS actor_email, s.email AS institution_actor_email,
              t.company_name AS tenant_name, m.display_name AS merchant_name
         FROM platform_audit_log a
         LEFT JOIN users u ON u.id = a.actor_user_id
         LEFT JOIN institution_staff s ON s.id = a.actor_institution_staff_id
         LEFT JOIN tenants t ON t.id = a.tenant_id
         LEFT JOIN merchants m ON m.id = a.merchant_id AND m.tenant_id = a.tenant_id
        WHERE ${whereClause}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      pageParams
    )
    res.json({
      events: rows.map((row) => ({
        id: row.id,
        actorUserId: row.actor_user_id,
        actorInstitutionStaffId: row.actor_institution_staff_id,
        actorEmail: row.actor_email || row.institution_actor_email || null,
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        merchantId: row.merchant_id,
        merchantName: row.merchant_name,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        details: row.details,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        requestId: row.request_id,
        createdAt: row.created_at
      })),
      totalCount: count.rows[0].total_count,
      page: filters.page,
      pageSize: filters.pageSize,
      totalPages: Math.ceil(count.rows[0].total_count / filters.pageSize)
    })
  } catch (error) { next(error) }
})

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
