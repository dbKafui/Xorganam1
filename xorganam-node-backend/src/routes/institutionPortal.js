import crypto from 'node:crypto'
import { Router } from 'express'
import { query, withTransaction } from '../db/pool.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { institutionAuthenticate } from '../middleware/institutionAuth.js'
import { requireInstitutionPermission } from '../middleware/requireInstitutionPermission.js'
import { hashPassword, verifyPassword } from '../security/password.js'
import { signToken } from '../security/jwt.js'
import { institutionDisputeScope, institutionLinkScope } from '../services/institutionScope.js'
import { institutionMembershipAdapterInternals } from '../services/institutionMembershipAdapterService.js'

export const institutionAuthRouter = Router()
export const institutionPortalRouter = Router()

function mapStaff(row) {
  return {
    id: row.id,
    institutionId: row.institution_id,
    institutionName: row.institution_name || null,
    branchId: row.branch_id || null,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at
  }
}

function errorStatus(error) {
  return error?.code === '23505' ? 409 : null
}

async function writeLinkAudit(client, institutionId, linkId, staffId, action, note) {
  await client.query(
    `INSERT INTO institution_audit_log
       (institution_id, tenant_institution_link_id, actor_staff_id, action, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [institutionId, linkId, staffId, action, note ? { note } : null]
  )
}

async function notifyTenantUsers(client, tenantId, notificationType, title, body, data) {
  await client.query(
    `INSERT INTO tenant_notifications (tenant_id, user_id, notification_type, title, body, data)
     SELECT u.tenant_id, u.id, $2, $3, $4, $5::jsonb
       FROM users u
      WHERE u.tenant_id = $1 AND u.is_active`,
    [tenantId, notificationType, title, body, JSON.stringify(data)]
  )
}

function scopedLinkSql(alias, auth) {
  const scope = institutionLinkScope(alias, auth)
  return { sql: scope.clause, params: scope.params }
}

institutionAuthRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {}
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      return res.status(400).json({ message: 'Email and password are required.' })
    }

    const { rows } = await query(
      `SELECT s.id, s.institution_id, i.name AS institution_name, s.branch_id,
              s.first_name, s.last_name, s.email, s.role, s.password_hash, s.is_active, s.created_at
         FROM institution_staff s
         JOIN institutions i ON i.id = s.institution_id AND i.status = 'ACTIVE'
        WHERE lower(s.email) = lower($1)`,
      [email.trim()]
    )

    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ message: 'Invalid email or password.' })
    }

    const staff = rows[0]
    if (!(await verifyPassword(password, staff.password_hash))) {
      return res.status(401).json({ message: 'Invalid email or password.' })
    }

    const token = signToken({
      id: staff.id,
      institutionId: staff.institution_id,
      institutionStaffId: staff.id,
      role: staff.role
    })
    await query('UPDATE institution_staff SET last_login_at = now(), updated_at = now() WHERE id = $1', [staff.id])
    res.json({ token, staff: mapStaff(staff) })
  })
)

institutionAuthRouter.get(
  '/me',
  institutionAuthenticate,
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT s.id, s.institution_id, i.name AS institution_name, s.branch_id,
              s.first_name, s.last_name, s.email, s.role, s.is_active, s.created_at
         FROM institution_staff s
         JOIN institutions i ON i.id = s.institution_id
        WHERE s.id = $1 AND s.institution_id = $2`,
      [req.institutionAuth.id, req.institutionAuth.institutionId]
    )
    if (!rows.length) return res.status(404).json({ message: 'Institution staff record not found.' })
    res.json({ staff: mapStaff(rows[0]) })
  })
)

institutionPortalRouter.use(institutionAuthenticate)

institutionPortalRouter.get(
  '/dashboard',
  requireInstitutionPermission('dashboard:view'),
  asyncHandler(async (req, res) => {
    const scope = scopedLinkSql('l', req.institutionAuth)
    const [links, queue, staff, disputes] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total FROM tenant_institution_links l WHERE ${scope.sql}`, scope.params),
      query(
        `SELECT COUNT(*)::int AS total FROM tenant_institution_links l
          WHERE ${scope.sql} AND l.verification_status IN ('PENDING', 'UNDER_REVIEW')`,
        scope.params
      ),
      req.institutionAuth.role === 'INSTITUTION_ADMIN'
        ? query(`SELECT COUNT(*)::int AS total FROM institution_staff WHERE institution_id = $1 AND is_active`, [req.institutionAuth.institutionId])
        : Promise.resolve({ rows: [{ total: null }] }),
      (() => {
        const disputeScope = institutionDisputeScope('d', req.institutionAuth)
        return query(`SELECT COUNT(*)::int AS total FROM institution_dispute d WHERE ${disputeScope.clause} AND d.status <> 'RESOLVED'`, disputeScope.params)
      })()
    ])
    res.json({
      institutionId: req.institutionAuth.institutionId,
      links: Number(links.rows[0]?.total || 0),
      verificationQueue: Number(queue.rows[0]?.total || 0),
      activeStaff: staff.rows[0]?.total === null ? null : Number(staff.rows[0]?.total || 0),
      openDisputes: Number(disputes.rows[0]?.total || 0)
    })
  })
)

institutionPortalRouter.get(
  '/links',
  requireInstitutionPermission('verification:view_queue'),
  asyncHandler(async (req, res) => {
    const scope = scopedLinkSql('l', req.institutionAuth)
    const { rows } = await query(
      `SELECT l.id, l.tenant_id, l.institution_id, l.member_id, l.verification_status,
              l.verification_method, l.verified_at, l.verified_by_staff_id,
              l.sourced_by_staff_id, l.source_channel, l.status, l.linked_at,
              l.created_at, l.updated_at, l.min_percentage, l.max_percentage,
              l.min_fixed_amount, l.max_fixed_amount, l.frequency_mode_min,
              l.frequency_mode_max, l.periodic_schedule_min, l.periodic_schedule_max,
              l.priority_deduction_allowed, t.company_name AS tenant_name,
              t.contact_email AS tenant_email, a.field_officer_staff_id AS assigned_field_officer_id,
              a.escalated_to_supervisor_id,
              h.supervisor_staff_id AS assigned_supervisor_staff_id,
              source_staff.first_name || ' ' || source_staff.last_name AS sourced_by_staff_name,
              (SELECT COUNT(*)::int FROM tenant_institution_link_verification_evidence e
                WHERE e.tenant_institution_link_id = l.id) AS evidence_count
         FROM tenant_institution_links l
         JOIN tenants t ON t.id = l.tenant_id
         LEFT JOIN institution_member_assignment a
           ON a.tenant_institution_link_id = l.id AND a.effective_to IS NULL
         LEFT JOIN institution_staff_hierarchy h
            ON h.institution_id = a.institution_id
           AND h.field_officer_staff_id = a.field_officer_staff_id
           AND h.effective_to IS NULL
         LEFT JOIN institution_staff source_staff
           ON source_staff.id = l.sourced_by_staff_id
        WHERE ${scope.sql}
        ORDER BY l.linked_at DESC`,
      scope.params
    )
    res.json(rows)
  })
)

institutionPortalRouter.patch(
  '/links/:linkId/verify',
  requireInstitutionPermission('verification:action'),
  asyncHandler(async (req, res) => {
    const { decision, note } = req.body || {}
    if (!['APPROVED', 'REJECTED', 'UNDER_REVIEW'].includes(decision)) {
      return res.status(400).json({ message: 'decision must be APPROVED, REJECTED, or UNDER_REVIEW.' })
    }
    if (note !== undefined && (typeof note !== 'string' || note.length > 2000)) {
      return res.status(400).json({ message: 'note must be a string no longer than 2000 characters.' })
    }

    const result = await withTransaction(async (client) => {
      const scope = institutionLinkScope('l', req.institutionAuth, 3)
      const { rows } = await client.query(
        `SELECT l.id, l.tenant_id, l.verification_status, l.member_id
           FROM tenant_institution_links l
          WHERE l.id = $1 AND l.institution_id = $2 AND ${scope.clause}
          FOR UPDATE OF l`,
        [req.params.linkId, req.institutionAuth.institutionId, ...scope.params]
      )
      if (!rows.length) return { notFound: true }
      const link = rows[0]

      if (!['PENDING', 'UNDER_REVIEW'].includes(link.verification_status)) {
        return { conflict: true }
      }
      const { rows: updated } = await client.query(
        `UPDATE tenant_institution_links
            SET verification_status = $2,
                status = CASE WHEN $2 = 'APPROVED' THEN 'ACTIVE' ELSE status END,
                verified_by_staff_id = $3,
                verified_at = CASE WHEN $2 IN ('APPROVED', 'REJECTED') THEN now() ELSE verified_at END,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [link.id, decision, req.institutionAuth.id]
      )
      await writeLinkAudit(
        client, req.institutionAuth.institutionId, link.id, req.institutionAuth.id,
        `VERIFICATION_${decision}`, note || null
      )
      if (decision === 'APPROVED' || decision === 'REJECTED') {
        await notifyTenantUsers(
          client,
          link.tenant_id,
          `INSTITUTION_LINK_${decision}`,
          `Institution membership ${decision.toLowerCase()}`,
          `Your institution membership claim was ${decision.toLowerCase()}.`,
          { linkId: link.id, decision }
        )
      }
      return { link: updated[0] }
    })

    if (result.notFound) return res.status(404).json({ message: 'Verification link not found in your assigned scope.' })
    if (result.conflict) return res.status(409).json({ message: 'Only pending or under-review links can be decided.' })
    res.json({ status: 'ok', link: result.link })
  })
)

institutionPortalRouter.get(
  '/links/:linkId/evidence',
  requireInstitutionPermission('verification:view_queue'),
  asyncHandler(async (req, res) => {
    const scope = institutionLinkScope('l', req.institutionAuth, 2)
    const { rows } = await query(
      `SELECT e.id, e.tenant_institution_link_id, e.tenant_id, e.institution_id,
              e.merchant_id, e.note, e.recorded_at, e.recorded_by_staff_id,
              m.display_name AS merchant_name, s.first_name || ' ' || s.last_name AS recorded_by
         FROM tenant_institution_link_verification_evidence e
         JOIN tenant_institution_links l ON l.id = e.tenant_institution_link_id
         JOIN merchants m ON m.id = e.merchant_id AND m.tenant_id = e.tenant_id
         LEFT JOIN institution_staff s ON s.id = e.recorded_by_staff_id
        WHERE e.tenant_institution_link_id = $1 AND ${scope.sql}
        ORDER BY e.recorded_at DESC`,
      [req.params.linkId, ...scope.params]
    )
    res.json(rows)
  })
)

institutionPortalRouter.post(
  '/links/:linkId/evidence',
  requireInstitutionPermission('verification:action'),
  asyncHandler(async (req, res) => {
    const { merchantId, note } = req.body || {}
    if (!merchantId || (note !== undefined && (typeof note !== 'string' || note.length > 2000))) {
      return res.status(400).json({ message: 'merchantId and an optional note no longer than 2000 characters are required.' })
    }

    const result = await withTransaction(async (client) => {
      const { rows: links } = await client.query(
        `SELECT l.id, l.tenant_id FROM tenant_institution_links l
          WHERE l.id = $1 AND l.institution_id = $2`,
        [req.params.linkId, req.institutionAuth.institutionId]
      )
      if (!links.length) return { notFound: true }
      const link = links[0]
      if (req.institutionAuth.role !== 'INSTITUTION_ADMIN') {
        const scope = institutionLinkScope('l', req.institutionAuth, 2)
        const { rows: allowed } = await client.query(
          `SELECT 1 FROM tenant_institution_links l WHERE l.id = $1 AND ${scope.clause}`,
          [req.params.linkId, ...scope.params]
        )
        if (!allowed.length) return { notFound: true }
      }
      const { rows: merchants } = await client.query(
        `SELECT id FROM merchants WHERE id = $1 AND tenant_id = $2`,
        [merchantId, link.tenant_id]
      )
      if (!merchants.length) return { invalidMerchant: true }
      const { rows } = await client.query(
        `INSERT INTO tenant_institution_link_verification_evidence
           (tenant_institution_link_id, tenant_id, institution_id, merchant_id, note, recorded_by_staff_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [link.id, link.tenant_id, req.institutionAuth.institutionId, merchantId, note?.trim() || null, req.institutionAuth.id]
      )
      await writeLinkAudit(client, req.institutionAuth.institutionId, link.id, req.institutionAuth.id, 'VERIFICATION_EVIDENCE_ADDED', note || null)
      return { evidence: rows[0] }
    })
    if (result.notFound) return res.status(404).json({ message: 'Verification link not found in your assigned scope.' })
    if (result.invalidMerchant) return res.status(400).json({ message: 'Merchant does not belong to this tenant.' })
    res.status(201).json(result.evidence)
  })
)

institutionPortalRouter.get(
  '/staff',
  requireInstitutionPermission('staff:view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT s.id, s.institution_id, s.branch_id, s.first_name, s.last_name, s.email,
              s.role, s.is_active, s.referral_code, s.created_at, b.name AS branch_name
         FROM institution_staff s
         LEFT JOIN institution_branch b ON b.id = s.branch_id AND b.institution_id = s.institution_id
        WHERE s.institution_id = $1
          AND ($2 = 'INSTITUTION_ADMIN'
            OR s.id = $3
            OR ($2 = 'SUPERVISOR' AND EXISTS (
              SELECT 1 FROM institution_staff_hierarchy h
               WHERE h.institution_id = $1 AND h.field_officer_staff_id = s.id
                 AND h.supervisor_staff_id = $3 AND h.effective_to IS NULL
            )))
        ORDER BY s.role, s.last_name, s.first_name`,
      [req.institutionAuth.institutionId, req.institutionAuth.role, req.institutionAuth.id]
    )
    res.json(rows)
  })
)

institutionPortalRouter.post(
  '/staff',
  requireInstitutionPermission('staff:manage'),
  asyncHandler(async (req, res) => {
    const { firstName, lastName, email, password, role, branchId } = req.body || {}
    if (typeof firstName !== 'string' || !firstName.trim() ||
        typeof lastName !== 'string' || !lastName.trim() ||
        typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        typeof password !== 'string' || password.length < 12 ||
        !['FIELD_OFFICER', 'SUPERVISOR', 'INSTITUTION_ADMIN'].includes(role)) {
      return res.status(400).json({ message: 'Provide valid first and last names, email, a password of at least 12 characters, and a valid role.' })
    }
    if (branchId) {
      const { rows: branch } = await query(
        'SELECT id FROM institution_branch WHERE id = $1 AND institution_id = $2 AND is_active',
        [branchId, req.institutionAuth.institutionId]
      )
      if (!branch.length) return res.status(400).json({ message: 'Branch is not active in this institution.' })
    }
    const passwordHash = await hashPassword(password)
    try {
      const { rows } = await query(
        `INSERT INTO institution_staff (institution_id, branch_id, first_name, last_name, email, password_hash, role)
         VALUES ($1, $2, $3, $4, lower($5), $6, $7)
         RETURNING id, institution_id, branch_id, first_name, last_name, email, role, is_active, created_at`,
        [req.institutionAuth.institutionId, branchId || null, firstName.trim(), lastName.trim(), email.trim(), passwordHash, role]
      )
      res.status(201).json(rows[0])
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ message: 'A staff account with this email already exists.' })
      throw error
    }
  })
)

institutionPortalRouter.patch(
  '/staff/:staffId',
  requireInstitutionPermission('staff:manage'),
  asyncHandler(async (req, res) => {
    const { role, branchId, isActive } = req.body || {}
    if (role !== undefined && !['FIELD_OFFICER', 'SUPERVISOR', 'INSTITUTION_ADMIN'].includes(role)) {
      return res.status(400).json({ message: 'Invalid institution staff role.' })
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
      return res.status(400).json({ message: 'isActive must be a boolean.' })
    }
    if (branchId !== undefined && branchId !== null && typeof branchId !== 'string') {
      return res.status(400).json({ message: 'branchId must be a branch UUID or null.' })
    }
    const result = await withTransaction(async (client) => {
      const { rows: currentRows } = await client.query(
        `SELECT id, role, is_active FROM institution_staff
          WHERE id = $1 AND institution_id = $2 FOR UPDATE`,
        [req.params.staffId, req.institutionAuth.institutionId]
      )
      if (!currentRows.length) return { notFound: true }
      const current = currentRows[0]
      if (branchId) {
        const { rows: branchRows } = await client.query(
          `SELECT id FROM institution_branch
            WHERE id = $1 AND institution_id = $2 AND is_active FOR UPDATE`,
          [branchId, req.institutionAuth.institutionId]
        )
        if (!branchRows.length) return { invalidBranch: true }
      }
      const nextRole = role || current.role
      const nextActive = typeof isActive === 'boolean' ? isActive : current.is_active

      if (current.id === req.institutionAuth.id &&
          (nextRole !== 'INSTITUTION_ADMIN' || !nextActive)) {
        return { conflict: 'You cannot deactivate or demote your own institution administrator account.' }
      }
      if (current.role === 'INSTITUTION_ADMIN' && current.is_active &&
          (nextRole !== 'INSTITUTION_ADMIN' || !nextActive)) {
        const { rows: admins } = await client.query(
          `SELECT COUNT(*)::int AS count FROM institution_staff
            WHERE institution_id = $1 AND role = 'INSTITUTION_ADMIN' AND is_active`,
          [req.institutionAuth.institutionId]
        )
        if (admins[0].count <= 1) return { conflict: 'An institution must retain at least one active administrator.' }
      }

      const { rows } = await client.query(
        `UPDATE institution_staff
            SET role = $3,
                branch_id = CASE WHEN $4 THEN $5 ELSE branch_id END,
                is_active = $6,
                updated_at = now()
          WHERE id = $1 AND institution_id = $2
          RETURNING id, institution_id, branch_id, first_name, last_name, email, role, is_active, created_at`,
        [req.params.staffId, req.institutionAuth.institutionId, nextRole,
          Object.hasOwn(req.body || {}, 'branchId'), branchId || null, nextActive]
      )

      if (!nextActive || nextRole !== 'FIELD_OFFICER') {
        await client.query(
          `UPDATE institution_member_assignment
              SET effective_to = now()
            WHERE field_officer_staff_id = $1 AND institution_id = $2 AND effective_to IS NULL`,
          [current.id, req.institutionAuth.institutionId]
        )
      }
      if (!nextActive || nextRole !== 'FIELD_OFFICER' || current.role !== 'FIELD_OFFICER') {
        await client.query(
          `UPDATE institution_staff_hierarchy
              SET effective_to = now()
            WHERE institution_id = $1 AND field_officer_staff_id = $2 AND effective_to IS NULL`,
          [req.institutionAuth.institutionId, current.id]
        )
      }
      if (!nextActive || nextRole !== 'SUPERVISOR' || current.role !== 'SUPERVISOR') {
        await client.query(
          `UPDATE institution_staff_hierarchy
              SET effective_to = now()
            WHERE institution_id = $1 AND supervisor_staff_id = $2 AND effective_to IS NULL`,
          [req.institutionAuth.institutionId, current.id]
        )
      }
      return { row: rows[0] }
    })
    if (result.notFound) return res.status(404).json({ message: 'Staff member not found.' })
    if (result.invalidBranch) return res.status(400).json({ message: 'Branch is not active in this institution.' })
    if (result.conflict) return res.status(409).json({ message: result.conflict })
    res.json(result.row)
  })
)

institutionPortalRouter.patch(
  '/staff/:staffId/referral-code',
  requireInstitutionPermission('staff:manage'),
  asyncHandler(async (req, res) => {
    const code = `FO-${crypto.randomBytes(5).toString('hex').toUpperCase()}`
    const { rows } = await query(
      `UPDATE institution_staff SET referral_code = $3, updated_at = now()
        WHERE id = $1 AND institution_id = $2 AND role = 'FIELD_OFFICER' AND is_active
        RETURNING id, referral_code`,
      [req.params.staffId, req.institutionAuth.institutionId, code]
    )
    if (!rows.length) return res.status(404).json({ message: 'Active field officer not found.' })
    res.json(rows[0])
  })
)

institutionPortalRouter.get(
  '/branches',
  requireInstitutionPermission('institution_profile:view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT b.id, b.institution_id, b.name, b.code, b.address,
              b.eganow_settlement_account_ref, b.is_active, b.created_at, b.updated_at,
              COUNT(s.id)::int AS staff_count
         FROM institution_branch b
         LEFT JOIN institution_staff s ON s.branch_id = b.id AND s.institution_id = b.institution_id AND s.is_active
        WHERE b.institution_id = $1
        GROUP BY b.id
        ORDER BY b.name`,
      [req.institutionAuth.institutionId]
    )
    res.json(rows)
  })
)

institutionPortalRouter.post(
  '/branches',
  requireInstitutionPermission('institution_profile:write'),
  asyncHandler(async (req, res) => {
    const { name, code, address, eganowSettlementAccountRef } = req.body || {}
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 160 ||
        [code, address, eganowSettlementAccountRef].some((value) => value !== undefined && value !== null && typeof value !== 'string')) {
      return res.status(400).json({ message: 'Provide a branch name up to 160 characters and string values for optional branch fields.' })
    }
    try {
      const { rows } = await query(
        `INSERT INTO institution_branch (institution_id, name, code, address, eganow_settlement_account_ref)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [req.institutionAuth.institutionId, name.trim(), code?.trim() || null, address?.trim() || null, eganowSettlementAccountRef?.trim() || null]
      )
      res.status(201).json(rows[0])
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ message: 'A branch with this name or code already exists.' })
      throw error
    }
  })
)

institutionPortalRouter.patch(
  '/branches/:branchId',
  requireInstitutionPermission('institution_profile:write'),
  asyncHandler(async (req, res) => {
    const { name, code, address, eganowSettlementAccountRef, isActive } = req.body || {}
    if ((name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 160)) ||
        [code, address, eganowSettlementAccountRef].some((value) => value !== undefined && value !== null && typeof value !== 'string')) {
      return res.status(400).json({ message: 'Branch fields must be valid strings; name must be at most 160 characters.' })
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
      return res.status(400).json({ message: 'isActive must be a boolean.' })
    }
    let result
    try {
      result = await withTransaction(async (client) => {
        const { rows: branchRows } = await client.query(
          `SELECT id FROM institution_branch
            WHERE id = $1 AND institution_id = $2 FOR UPDATE`,
          [req.params.branchId, req.institutionAuth.institutionId]
        )
        if (!branchRows.length) return { row: null }
        if (isActive === false) {
          const { rows: staff } = await client.query(
            `SELECT 1 FROM institution_staff
              WHERE institution_id = $1 AND branch_id = $2 AND is_active LIMIT 1`,
            [req.institutionAuth.institutionId, req.params.branchId]
          )
          if (staff.length) return { hasActiveStaff: true }
        }
        const { rows } = await client.query(
          `UPDATE institution_branch
              SET name = COALESCE($3, name), code = CASE WHEN $4 THEN $5 ELSE code END,
                  address = CASE WHEN $6 THEN $7 ELSE address END,
                  eganow_settlement_account_ref = CASE WHEN $8 THEN $9 ELSE eganow_settlement_account_ref END,
                  is_active = COALESCE($10, is_active), updated_at = now()
            WHERE id = $1 AND institution_id = $2
            RETURNING *`,
          [req.params.branchId, req.institutionAuth.institutionId,
            name?.trim() || null, Object.hasOwn(req.body || {}, 'code'), code?.trim() || null,
            Object.hasOwn(req.body || {}, 'address'), address?.trim() || null,
            Object.hasOwn(req.body || {}, 'eganowSettlementAccountRef'), eganowSettlementAccountRef?.trim() || null,
            typeof isActive === 'boolean' ? isActive : null]
        )
        return { row: rows[0] || null }
      })
    } catch (error) {
      if (errorStatus(error) === 409) return res.status(409).json({ message: 'A branch with this name or code already exists.' })
      throw error
    }
    if (result.hasActiveStaff) return res.status(409).json({ message: 'Reassign active staff before deactivating this branch.' })
    if (!result.row) return res.status(404).json({ message: 'Branch not found.' })
    res.json(result.row)
  })
)

institutionPortalRouter.get(
  '/profile',
  requireInstitutionPermission('institution_profile:view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, name, institution_type, settlement_msisdn, settlement_account_name,
              settlement_country_code, api_verification_supported, verification_sla_hours,
              status, created_at, updated_at
         FROM institutions WHERE id = $1`,
      [req.institutionAuth.institutionId]
    )
    if (!rows.length) return res.status(404).json({ message: 'Institution not found.' })
    res.json(rows[0])
  })
)

institutionPortalRouter.patch(
  '/profile',
  requireInstitutionPermission('institution_profile:write'),
  asyncHandler(async (req, res) => {
    const { name, settlementMsisdn, settlementAccountName, settlementCountryCode,
      verificationSlaHours, apiVerificationSupported } = req.body || {}
    if ([name, settlementMsisdn, settlementAccountName, settlementCountryCode]
      .some((value) => value !== undefined && typeof value !== 'string')) {
      return res.status(400).json({ message: 'Institution profile values must be strings.' })
    }
    if (apiVerificationSupported !== undefined && typeof apiVerificationSupported !== 'boolean') {
      return res.status(400).json({ message: 'apiVerificationSupported must be a boolean.' })
    }
    if (verificationSlaHours !== undefined &&
        (!Number.isInteger(Number(verificationSlaHours)) || Number(verificationSlaHours) < 1 || Number(verificationSlaHours) > 8760)) {
      return res.status(400).json({ message: 'verificationSlaHours must be an integer between 1 and 8760.' })
    }
    const { rows } = await query(
      `UPDATE institutions
          SET name = COALESCE($2, name),
              settlement_msisdn = COALESCE($3, settlement_msisdn),
              settlement_account_name = COALESCE($4, settlement_account_name),
              settlement_country_code = COALESCE($5, settlement_country_code),
              verification_sla_hours = COALESCE($6, verification_sla_hours),
              api_verification_supported = COALESCE($7, api_verification_supported),
              updated_at = now()
        WHERE id = $1
        RETURNING id, name, institution_type, settlement_msisdn, settlement_account_name,
                  settlement_country_code, api_verification_supported, verification_sla_hours,
                  status, created_at, updated_at`,
      [req.institutionAuth.institutionId,
        typeof name === 'string' && name.trim() ? name.trim() : null,
        typeof settlementMsisdn === 'string' && settlementMsisdn.trim() ? settlementMsisdn.trim() : null,
        typeof settlementAccountName === 'string' && settlementAccountName.trim() ? settlementAccountName.trim() : null,
        typeof settlementCountryCode === 'string' && settlementCountryCode.trim() ? settlementCountryCode.trim() : null,
        verificationSlaHours === undefined ? null : Number(verificationSlaHours),
        typeof apiVerificationSupported === 'boolean' ? apiVerificationSupported : null]
    )
    if (!rows.length) return res.status(404).json({ message: 'Institution not found.' })
    res.json(rows[0])
  })
)

institutionPortalRouter.get(
  '/hierarchy',
  requireInstitutionPermission('assignment:manage'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT h.id, h.field_officer_staff_id, h.supervisor_staff_id, h.effective_from, h.effective_to,
              fo.first_name || ' ' || fo.last_name AS field_officer_name,
              su.first_name || ' ' || su.last_name AS supervisor_name
         FROM institution_staff_hierarchy h
         JOIN institution_staff fo ON fo.id = h.field_officer_staff_id
         JOIN institution_staff su ON su.id = h.supervisor_staff_id
        WHERE h.institution_id = $1
          AND ($2 = 'INSTITUTION_ADMIN' OR h.supervisor_staff_id = $3 OR h.field_officer_staff_id = $3)
        ORDER BY h.effective_from DESC`,
      [req.institutionAuth.institutionId, req.institutionAuth.role, req.institutionAuth.id]
    )
    res.json(rows)
  })
)

institutionPortalRouter.post(
  '/hierarchy',
  requireInstitutionPermission('assignment:manage'),
  asyncHandler(async (req, res) => {
    const { fieldOfficerStaffId, supervisorStaffId } = req.body || {}
    if (!fieldOfficerStaffId || !supervisorStaffId || fieldOfficerStaffId === supervisorStaffId) {
      return res.status(400).json({ message: 'Distinct fieldOfficerStaffId and supervisorStaffId are required.' })
    }
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id, role FROM institution_staff
          WHERE institution_id = $1 AND is_active AND id = ANY($2::uuid[])`,
        [req.institutionAuth.institutionId, [fieldOfficerStaffId, supervisorStaffId]]
      )
      if (rows.length !== 2 ||
          rows.find((staff) => staff.id === fieldOfficerStaffId)?.role !== 'FIELD_OFFICER' ||
          rows.find((staff) => staff.id === supervisorStaffId)?.role !== 'SUPERVISOR') {
        return { invalid: true }
      }
      if (req.institutionAuth.role === 'SUPERVISOR' && supervisorStaffId !== req.institutionAuth.id) {
        return { invalid: true }
      }
      if (req.institutionAuth.role === 'SUPERVISOR') {
        const { rows: existing } = await client.query(
          `SELECT supervisor_staff_id FROM institution_staff_hierarchy
            WHERE institution_id = $1 AND field_officer_staff_id = $2 AND effective_to IS NULL
            FOR UPDATE`,
          [req.institutionAuth.institutionId, fieldOfficerStaffId]
        )
        if (existing.length && existing[0].supervisor_staff_id !== req.institutionAuth.id) {
          return { invalid: true }
        }
      }
      await client.query(
        `UPDATE institution_staff_hierarchy
            SET effective_to = now()
          WHERE institution_id = $1 AND field_officer_staff_id = $2 AND effective_to IS NULL`,
        [req.institutionAuth.institutionId, fieldOfficerStaffId]
      )
      const { rows: hierarchy } = await client.query(
        `INSERT INTO institution_staff_hierarchy
           (institution_id, field_officer_staff_id, supervisor_staff_id)
         VALUES ($1, $2, $3) RETURNING *`,
        [req.institutionAuth.institutionId, fieldOfficerStaffId, supervisorStaffId]
      )
      return { row: hierarchy[0] }
    })
    if (result.invalid) return res.status(400).json({ message: 'Choose an active field officer and supervisor within your institution.' })
    res.status(201).json(result.row)
  })
)

institutionPortalRouter.get(
  '/assignments',
  requireInstitutionPermission('assignment:manage'),
  asyncHandler(async (req, res) => {
    const scope = scopedLinkSql('l', req.institutionAuth)
    const { rows } = await query(
      `SELECT a.id, a.tenant_institution_link_id, a.tenant_id, a.field_officer_staff_id,
              a.assigned_by_staff_id, a.effective_from, a.effective_to, a.created_at,
              s.first_name || ' ' || s.last_name AS officer_name, l.member_id
         FROM institution_member_assignment a
         JOIN institution_staff s ON s.id = a.field_officer_staff_id
         JOIN tenant_institution_links l ON l.id = a.tenant_institution_link_id
        WHERE ${scope.sql}
          AND ($${scope.params.length + 1} = 'INSTITUTION_ADMIN'
            OR a.field_officer_staff_id = $${scope.params.length + 2}
            OR EXISTS (SELECT 1 FROM institution_staff_hierarchy h
                        WHERE h.institution_id = a.institution_id
                          AND h.field_officer_staff_id = a.field_officer_staff_id
                          AND h.supervisor_staff_id = $${scope.params.length + 2}
                          AND h.effective_to IS NULL))
        ORDER BY a.effective_from DESC`,
      [...scope.params, req.institutionAuth.role, req.institutionAuth.id]
    )
    res.json(rows)
  })
)

institutionPortalRouter.post(
  '/assignments',
  requireInstitutionPermission('assignment:manage'),
  asyncHandler(async (req, res) => {
    const { tenantInstitutionLinkId, fieldOfficerStaffId } = req.body || {}
    if (!tenantInstitutionLinkId || !fieldOfficerStaffId) {
      return res.status(400).json({ message: 'tenantInstitutionLinkId and fieldOfficerStaffId are required.' })
    }
    const result = await withTransaction(async (client) => {
      const { rows: links } = await client.query(
        `SELECT id, tenant_id FROM tenant_institution_links
          WHERE id = $1 AND institution_id = $2 FOR UPDATE`,
        [tenantInstitutionLinkId, req.institutionAuth.institutionId]
      )
      if (!links.length) return { notFound: true }
      if (req.institutionAuth.role === 'SUPERVISOR') {
        const { rows: currentAssignment } = await client.query(
          `SELECT field_officer_staff_id FROM institution_member_assignment
            WHERE tenant_institution_link_id = $1 AND effective_to IS NULL
            FOR UPDATE`,
          [tenantInstitutionLinkId]
        )
        if (currentAssignment.length) {
          const { rows: currentScope } = await client.query(
            `SELECT 1 FROM institution_staff_hierarchy
              WHERE institution_id = $1 AND field_officer_staff_id = $2
                AND supervisor_staff_id = $3 AND effective_to IS NULL`,
            [req.institutionAuth.institutionId, currentAssignment[0].field_officer_staff_id, req.institutionAuth.id]
          )
          if (!currentScope.length) return { invalidOfficer: true }
        }
      }
      const { rows: officers } = await client.query(
        `SELECT id, role FROM institution_staff
          WHERE id = $1 AND institution_id = $2 AND is_active`,
        [fieldOfficerStaffId, req.institutionAuth.institutionId]
      )
      if (!officers.length || officers[0].role !== 'FIELD_OFFICER') return { invalidOfficer: true }
      if (req.institutionAuth.role === 'SUPERVISOR') {
        const { rows: report } = await client.query(
          `SELECT 1 FROM institution_staff_hierarchy
            WHERE institution_id = $1 AND field_officer_staff_id = $2
              AND supervisor_staff_id = $3 AND effective_to IS NULL`,
          [req.institutionAuth.institutionId, fieldOfficerStaffId, req.institutionAuth.id]
        )
        if (!report.length) return { invalidOfficer: true }
      }
      await client.query(
        `UPDATE institution_member_assignment SET effective_to = now()
          WHERE tenant_institution_link_id = $1 AND effective_to IS NULL`,
        [tenantInstitutionLinkId]
      )
      const { rows } = await client.query(
        `INSERT INTO institution_member_assignment
           (institution_id, tenant_id, tenant_institution_link_id, field_officer_staff_id, assigned_by_staff_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.institutionAuth.institutionId, links[0].tenant_id, tenantInstitutionLinkId,
          fieldOfficerStaffId, req.institutionAuth.id]
      )
      return { row: rows[0] }
    })
    if (result.notFound) return res.status(404).json({ message: 'Institution link not found.' })
    if (result.invalidOfficer) return res.status(400).json({ message: 'Selected staff member is not an active field officer in your institution scope.' })
    res.status(201).json(result.row)
  })
)

institutionPortalRouter.get(
  '/reconciliation',
  requireInstitutionPermission('reconciliation:view'),
  asyncHandler(async (req, res) => {
    const scope = institutionLinkScope('l', req.institutionAuth, 2)
    const { rows } = await query(
      `SELECT r.*
         FROM institution_sweep_reconciliation r
        WHERE r.institution_id = $1
          AND EXISTS (
            SELECT 1 FROM tenant_institution_links l
              WHERE l.institution_id = r.institution_id
                AND l.tenant_id = r.tenant_id
                AND ${scope.clause}
          )
        ORDER BY r.created_at DESC`,
      [req.institutionAuth.institutionId, ...scope.params]
    )
    res.json(rows)
  })
)

institutionPortalRouter.get(
  '/disputes',
  requireInstitutionPermission('dispute:view'),
  asyncHandler(async (req, res) => {
    const scope = institutionDisputeScope('d', req.institutionAuth)
    const { rows } = await query(
      `SELECT d.*, t.internal_reference, t.type AS transaction_type,
              u.first_name || ' ' || u.last_name AS raised_by_tenant_user
         FROM institution_dispute d
         LEFT JOIN transactions t ON t.id = d.transaction_id
         LEFT JOIN users u ON u.id = d.raised_by_tenant_user_id
        WHERE ${scope.clause}
        ORDER BY d.created_at DESC`,
      scope.params
    )
    res.json(rows)
  })
)

institutionPortalRouter.post(
  '/disputes',
  requireInstitutionPermission('dispute:raise'),
  asyncHandler(async (req, res) => {
    const { tenantId, merchantId, transactionId, reason, channel = 'EMAIL' } = req.body || {}
    if (!tenantId || !merchantId || !transactionId ||
        typeof reason !== 'string' || !reason.trim() || reason.length > 4000 ||
        !['APP', 'EMAIL'].includes(channel)) {
      return res.status(400).json({ message: 'tenantId, merchantId, transactionId, reason, and a valid APP or EMAIL channel are required.' })
    }
    const scope = institutionLinkScope('l', req.institutionAuth, 8)
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO institution_dispute
           (institution_id, tenant_id, merchant_id, transaction_id, raised_by_staff_id, channel, reason)
         SELECT $1, $2, $3, t.id, $5, $6, $7
           FROM transactions t
          WHERE t.id = $4 AND t.tenant_id = $2 AND t.merchant_id = $3
            AND t.type IN ('COLLECTION', 'SWEEP_PAYOUT')
            AND EXISTS (
              SELECT 1 FROM tenant_institution_links l
               WHERE l.institution_id = $1 AND l.tenant_id = $2
                 AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED'
                 AND ${scope.clause}
            )
         RETURNING *`,
        [req.institutionAuth.institutionId, tenantId, merchantId, transactionId,
          req.institutionAuth.id, channel, reason.trim(), ...scope.params]
      )
      if (!rows.length) return { notFound: true }
      await client.query(
        `INSERT INTO institution_audit_log (institution_id, dispute_id, actor_staff_id, action, note)
         VALUES ($1, $2, $3, 'DISPUTE_RAISED', $4)`,
        [req.institutionAuth.institutionId, rows[0].id, req.institutionAuth.id, { channel }]
      )
      return { row: rows[0] }
    })
    if (result.notFound) return res.status(404).json({ message: 'Transaction is not in your institution scope.' })
    res.status(201).json(result.row)
  })
)

institutionPortalRouter.patch(
  '/disputes/:disputeId',
  requireInstitutionPermission('dispute:resolve'),
  asyncHandler(async (req, res) => {
    const { status, resolutionNote } = req.body || {}
    if (!['UNDER_REVIEW', 'RESOLVED'].includes(status) ||
        (resolutionNote !== undefined && (typeof resolutionNote !== 'string' || resolutionNote.length > 4000))) {
      return res.status(400).json({ message: 'status must be UNDER_REVIEW or RESOLVED and resolutionNote must be at most 4000 characters.' })
    }
    const scope = institutionDisputeScope('d', req.institutionAuth, 2)
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT d.* FROM institution_dispute d
          WHERE d.id = $1 AND ${scope.clause}
          FOR UPDATE`,
        [req.params.disputeId, ...scope.params]
      )
      if (!rows.length) return { notFound: true }
      const current = rows[0]
      if (current.status === 'RESOLVED') return { conflict: true }
      if ((status === 'UNDER_REVIEW' && current.status !== 'OPEN') ||
          (status === 'RESOLVED' && current.status !== 'UNDER_REVIEW')) return { conflict: true }
      const { rows: updated } = await client.query(
        `UPDATE institution_dispute
            SET status = $2, resolution_note = COALESCE($3, resolution_note),
                resolved_by_staff_id = CASE WHEN $2 = 'RESOLVED' THEN $4 ELSE resolved_by_staff_id END,
                resolved_at = CASE WHEN $2 = 'RESOLVED' THEN now() ELSE resolved_at END,
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [current.id, status, resolutionNote?.trim() || null, req.institutionAuth.id]
      )
      await client.query(
        `INSERT INTO institution_audit_log (institution_id, dispute_id, actor_staff_id, action, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.institutionAuth.institutionId, current.id, req.institutionAuth.id,
          `DISPUTE_${status}`, resolutionNote?.trim() ? { resolutionNote: resolutionNote.trim() } : null]
      )
      await notifyTenantUsers(
        client,
        current.tenant_id,
        'INSTITUTION_DISPUTE_STATUS',
        'Institution dispute updated',
        `Your institution dispute is now ${status.replaceAll('_', ' ').toLowerCase()}.`,
        { disputeId: current.id, status }
      )
      return { row: updated[0] }
    })
    if (result.notFound) return res.status(404).json({ message: 'Dispute not found in your institution scope.' })
    if (result.conflict) return res.status(409).json({ message: 'Dispute status transition is not allowed.' })
    res.json(result.row)
  })
)

institutionPortalRouter.get(
  '/adapter-config',
  requireInstitutionPermission('institution_profile:view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, institution_id, adapter_type, base_url, auth_type,
              CASE WHEN auth_config IS NULL THEN NULL ELSE jsonb_build_object('secretRef', auth_config->>'secretRef') END AS auth_config,
              request_template, response_active_path, response_detail_path,
              custom_adapter_key, created_at
         FROM institution_api_adapter_config WHERE institution_id = $1`,
      [req.institutionAuth.institutionId]
    )
    res.json(rows[0] || null)
  })
)

institutionPortalRouter.put(
  '/adapter-config',
  requireInstitutionPermission('institution_profile:write'),
  asyncHandler(async (req, res) => {
    const { adapterType = 'GENERIC_REST', baseUrl, authType = 'NONE', authConfig, requestTemplate,
      responseActivePath, responseDetailPath, customAdapterKey } = req.body || {}
    if (!['GENERIC_REST', 'CUSTOM'].includes(adapterType) || !['NONE', 'API_KEY', 'BEARER', 'BASIC'].includes(authType)) {
      return res.status(400).json({ message: 'Unsupported membership adapter or authentication type.' })
    }
    if (adapterType === 'GENERIC_REST') {
      try {
        institutionMembershipAdapterInternals.validateBaseUrl(baseUrl)
      } catch (error) {
        return res.status(400).json({ message: error.message })
      }
      try {
        institutionMembershipAdapterInternals.normalizeRequestTemplate(requestTemplate, 'validation-member')
      } catch (error) {
        return res.status(400).json({ message: error.message })
      }
      if (typeof responseActivePath !== 'string' || !responseActivePath.trim()) {
        return res.status(400).json({ message: 'responseActivePath is required for generic membership lookup.' })
      }
    }
    if (adapterType === 'CUSTOM' && (typeof customAdapterKey !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(customAdapterKey))) {
      return res.status(400).json({ message: 'A valid customAdapterKey is required.' })
    }
    const secretRef = authConfig && typeof authConfig === 'object' ? authConfig.secretRef : null
    if (authType !== 'NONE' && (typeof secretRef !== 'string' || !/^[A-Z][A-Z0-9_]{2,127}$/.test(secretRef))) {
      return res.status(400).json({ message: 'authConfig.secretRef must name a secrets environment variable; raw credentials are not accepted.' })
    }
    if (authType === 'NONE' && secretRef) {
      return res.status(400).json({ message: 'Do not provide a secret reference when authType is NONE.' })
    }
    const safeRequestTemplate = adapterType === 'GENERIC_REST' ? requestTemplate : null
    const { rows } = await query(
      `INSERT INTO institution_api_adapter_config (
         institution_id, adapter_type, base_url, auth_type, auth_config,
         request_template, response_active_path, response_detail_path, custom_adapter_key
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
       ON CONFLICT (institution_id) DO UPDATE SET
         adapter_type = EXCLUDED.adapter_type, base_url = EXCLUDED.base_url,
         auth_type = EXCLUDED.auth_type, auth_config = EXCLUDED.auth_config,
         request_template = EXCLUDED.request_template,
         response_active_path = EXCLUDED.response_active_path,
         response_detail_path = EXCLUDED.response_detail_path,
         custom_adapter_key = EXCLUDED.custom_adapter_key
       RETURNING id, institution_id, adapter_type, base_url, auth_type,
                 CASE WHEN auth_config IS NULL THEN NULL ELSE jsonb_build_object('secretRef', auth_config->>'secretRef') END AS auth_config,
                 request_template, response_active_path, response_detail_path, custom_adapter_key, created_at`,
      [req.institutionAuth.institutionId, adapterType,
        adapterType === 'GENERIC_REST' ? baseUrl : null, authType,
        secretRef ? JSON.stringify({ secretRef }) : null,
        safeRequestTemplate ? JSON.stringify(safeRequestTemplate) : null,
        responseActivePath?.trim() || null, responseDetailPath?.trim() || null,
        adapterType === 'CUSTOM' ? customAdapterKey.trim() : null]
    )
    res.json(rows[0])
  })
)
